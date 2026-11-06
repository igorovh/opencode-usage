/**
 * Codex (ChatGPT) usage via https://chatgpt.com/backend-api/wham/usage
 *
 * Token sources, in order:
 * 1. Codex CLI credentials at $CODEX_HOME/auth.json (~/.codex), refreshed by `codex login`
 * 2. The OpenCode "openai" OAuth credential (ChatGPT login via /connect)
 * 3. The V1 auth.json "openai" entry
 */

import {
  codexCliTokens,
  credentialOAuth,
  credentialsFor,
  legacyAuthEntry,
  parseOpenAiJwt,
  stringField,
} from "./auth";
import { clampPct, describe, fetchJson, HttpError, isoFromNowPlusSeconds, rateLimitedUntil, toIso } from "./http";
import { errorResult, missingResult, type QuotaResult, type UsageWindow } from "./types";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const OPENAI_IDS = ["openai"] as const;
const USER_AGENT = "opencode-usage";

interface WhamWindow {
  used_percent?: number;
  remaining_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
}

interface WhamUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: WhamWindow;
    secondary_window?: WhamWindow;
  } | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
}

function windowLabel(limitWindowSeconds: unknown): string | undefined {
  if (typeof limitWindowSeconds !== "number") return undefined;
  if (limitWindowSeconds === 18_000) return "5h";
  if (limitWindowSeconds === 604_800) return "7d";
  if (limitWindowSeconds === 2_628_000) return "30d";
  const hours = Math.round(limitWindowSeconds / 3600);
  return hours > 0 ? `${hours}h` : undefined;
}

function usedFromWindow(window: WhamWindow): number | undefined {
  if (typeof window.used_percent === "number") return clampPct(window.used_percent);
  if (typeof window.remaining_percent === "number") return clampPct(100 - window.remaining_percent);
  return undefined;
}

function resetFromWindow(window: WhamWindow): string | undefined {
  return toIso(window.reset_at) ?? isoFromNowPlusSeconds(window.reset_after_seconds);
}

export function parseWindows(response: WhamUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const window of [response.rate_limit?.primary_window, response.rate_limit?.secondary_window]) {
    if (!window) continue;
    const label = windowLabel(window.limit_window_seconds);
    const used = usedFromWindow(window);
    if (!label || used === undefined || seen.has(label)) continue;
    seen.add(label);
    windows.push({ label, usedPct: used, resetsAt: resetFromWindow(window) });
  }
  return windows;
}

interface CodexCandidate {
  accessToken: string;
  accountId?: string;
}

function accountIdFrom(token: string, fallback?: string): string | undefined {
  return parseOpenAiJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? fallback;
}

async function tokenCandidates(): Promise<CodexCandidate[]> {
  const candidates: CodexCandidate[] = [];
  const now = Date.now();

  // Codex CLI first: `codex login` keeps it fresh, while stored OAuth can go stale.
  const cli = await codexCliTokens();
  if (cli) candidates.push(cli);

  for (const credential of await credentialsFor(OPENAI_IDS)) {
    const oauth = credentialOAuth(credential);
    if (!oauth || (oauth.expires !== undefined && oauth.expires < now)) continue;
    candidates.push({
      accessToken: oauth.access,
      accountId: accountIdFrom(oauth.access, stringField(oauth.metadata, "accountID")),
    });
  }

  const legacy = await legacyAuthEntry(OPENAI_IDS);
  const access = legacy?.entry.type === "oauth" ? legacy.entry.access?.trim() : undefined;
  const expired = typeof legacy?.entry.expires === "number" && legacy.entry.expires < now;
  if (access && !expired) candidates.push({ accessToken: access, accountId: accountIdFrom(access, legacy?.entry.accountId) });

  const seen = new Set<string>();
  return candidates.filter((candidate) => !seen.has(candidate.accessToken) && !!seen.add(candidate.accessToken));
}

export async function queryCodex(): Promise<QuotaResult> {
  const candidates = await tokenCandidates();
  if (candidates.length === 0) {
    return missingResult(
      "No Codex/ChatGPT OAuth token found (connect ChatGPT via /connect or run `codex login`).",
    );
  }

  let lastError: string | undefined;
  for (const tokens of candidates) {
    // The ChatGPT backend occasionally 401s valid tokens; one quick retry, then the next source.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${tokens.accessToken}`,
          "user-agent": USER_AGENT,
        };
        if (tokens.accountId) headers["chatgpt-account-id"] = tokens.accountId;
        const data = await fetchJson<WhamUsageResponse>(USAGE_URL, { headers });
        const windows = parseWindows(data);
        if (windows.length === 0) return errorResult("No quota windows in Codex usage response.");
        const plan = data.plan_type ? capitalize(data.plan_type) : undefined;
        return { ok: true, plan, windows };
      } catch (error) {
        const limitedUntil = rateLimitedUntil(error);
        if (limitedUntil) return errorResult("Codex: rate limited (HTTP 429).", limitedUntil);
        lastError = describe(error, "Codex");
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            continue;
          }
          break;
        }
        return errorResult(lastError);
      }
    }
  }
  return errorResult(lastError ?? "Codex: unknown error.");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
