/**
 * Codex (ChatGPT) usage via https://chatgpt.com/backend-api/wham/usage
 *
 * Token sources, in order:
 * 1. OpenCode auth.json OAuth entries ("openai", "codex", "chatgpt", "opencode")
 * 2. Codex CLI credentials at ~/.codex/auth.json
 */

import {
  codexCliTokens,
  opencodeAuthEntry,
  parseOpenAiJwt,
  type OpencodeAuthEntry,
} from "./auth";
import { clampPct, fetchJson, isoFromNowPlusSeconds, toIso } from "./http";
import { errorResult, missingResult, type QuotaResult, type UsageWindow } from "./types";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const OPENAI_AUTH_KEYS = ["openai", "codex", "chatgpt", "opencode"] as const;

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

function parseWindows(response: WhamUsageResponse): UsageWindow[] {
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

async function tokenCandidates(): Promise<{ accessToken: string; accountId?: string }[]> {
  const candidates: { accessToken: string; accountId?: string }[] = [];

  // Codex CLI credentials first: `codex login` refreshes them, while the
  // OpenCode auth.json entry can stay stale for a long time.
  const cli = await codexCliTokens();
  if (cli) candidates.push({ accessToken: cli.accessToken, accountId: cli.accountId });

  const entry = await opencodeAuthEntry(OPENAI_AUTH_KEYS);
  const fromOpencode = entry ? oauthAccessToken(entry.entry) : undefined;
  if (fromOpencode) {
    const expired = typeof entry?.entry.expires === "number" && entry.entry.expires < Date.now();
    if (!expired) {
      const jwt = parseOpenAiJwt(fromOpencode);
      candidates.push({
        accessToken: fromOpencode,
        accountId:
          jwt?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? entry?.entry.accountId,
      });
    }
  }

  return candidates;
}

function oauthAccessToken(entry: OpencodeAuthEntry): string | undefined {
  if (entry.type && entry.type !== "oauth") return undefined;
  return entry.access?.trim() || undefined;
}

export async function queryCodex(): Promise<QuotaResult> {
  const candidates = await tokenCandidates();
  if (candidates.length === 0) {
    return missingResult(
      "No Codex/ChatGPT OAuth token found (connect via /connect or run `codex login`).",
    );
  }

  let lastError: string | undefined;
  for (const tokens of candidates) {
    // The ChatGPT backend occasionally 401s/429s valid tokens; one quick retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${tokens.accessToken}`,
          "user-agent": "opencode2-usage/0.1",
        };
        if (tokens.accountId) headers["chatgpt-account-id"] = tokens.accountId;
        const data = await fetchJson<WhamUsageResponse>(USAGE_URL, { headers });
        const windows = parseWindows(data);
        if (windows.length === 0) return errorResult("No quota windows in Codex usage response.");
        const plan = data.plan_type ? capitalize(data.plan_type) : undefined;
        return { ok: true, plan, windows };
      } catch (error) {
        lastError = describe(error, "Codex");
        if (/HTTP 40[13]|HTTP 429/.test(lastError)) {
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            continue;
          }
          break; // try the next credential source
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

export function describe(error: unknown, provider: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401|HTTP 403/.test(message)) {
    return `${provider}: unauthorized - token expired, re-authenticate.`;
  }
  return `${provider}: ${message}`;
}
