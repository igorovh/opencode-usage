/**
 * OpenCode Go usage via GET {base}/zen/go/v1/usage
 *
 * Same endpoint the web console is built on. Auth is the regular Go API key
 * (`Authorization: Bearer <key>`), resolved like opencode does:
 * explicit option -> OPENCODE_API_KEY env -> auth.json (`opencode-go`, then
 * `opencode` fallback). OAuth tokens don't pass the endpoint's KeyTable
 * check - an API key from opencode.ai/auth (or `opencode auth login`) is needed.
 */

import { opencodeAuthEntry } from "./auth";
import { clampPct, fetchJson, HttpError } from "./http";
import { errorResult, missingResult, type QuotaResult, type UsageWindow } from "./types";
import { describe } from "./codex";

export const GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go";
const GO_TIMEOUT_MS = 15_000;

interface GoWindow {
  status?: string;
  percent?: number;
  resetsAt?: string;
}

interface GoUsageResponse {
  usage?: {
    rolling?: GoWindow;
    weekly?: GoWindow;
    monthly?: GoWindow;
  };
}

function toWindow(window: GoWindow | undefined, label: string): UsageWindow | undefined {
  if (!window || typeof window.percent !== "number" || !Number.isFinite(window.percent)) {
    return undefined;
  }
  const resetsAt =
    typeof window.resetsAt === "string" && !Number.isNaN(Date.parse(window.resetsAt))
      ? window.resetsAt
      : undefined;
  return { label, usedPct: clampPct(window.percent), resetsAt };
}

function parseWindows(body: GoUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];
  // Monthly quota is shown as "1m" (per plugin convention) instead of "30d".
  for (const [key, label] of [["rolling", "5h"], ["weekly", "7d"], ["monthly", "1m"]] as const) {
    const window = toWindow(body.usage?.[key], label);
    if (window) windows.push(window);
  }
  return windows;
}

export async function resolveGoKey(explicit?: string): Promise<string | undefined> {
  if (explicit?.trim()) return explicit.trim();

  const fromEnv = process.env["OPENCODE_API_KEY"]?.trim();
  if (fromEnv) return fromEnv;

  // Dedicated `opencode-go` entry wins over the legacy `opencode` entry.
  const entry = await opencodeAuthEntry(["opencode-go", "opencode"]);
  const raw = entry?.entry;
  const fromAuth =
    raw?.key?.trim() ||
    (raw as { apiKey?: string } | undefined)?.apiKey?.trim() ||
    raw?.access?.trim();
  if (fromAuth) return fromAuth;

  return undefined;
}

function resolveBaseUrl(explicit?: string): string {
  const base = explicit?.trim() || GO_DEFAULT_BASE_URL;
  const stripped = base.replace(/\/+$/, "");
  const parsed = new URL(stripped);
  if (parsed.protocol === "https:") return stripped;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)) {
      return stripped;
    }
  }
  throw new Error(`OpenCode Go: baseUrl must use https (http only allowed for localhost).`);
}

export async function queryOpencodeGo(
  overrides: { apiKey?: string; baseUrl?: string } = {},
): Promise<QuotaResult> {
  const apiKey = await resolveGoKey(overrides.apiKey);
  if (!apiKey) {
    return missingResult(
      "No OpenCode Go API key found (set OPENCODE_API_KEY or run `opencode auth login`).",
    );
  }

  let base: string;
  try {
    base = resolveBaseUrl(overrides.baseUrl);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  try {
    const body = await fetchJson<GoUsageResponse>(`${base}/v1/usage`, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: GO_TIMEOUT_MS,
    });
    const windows = parseWindows(body);
    if (windows.length === 0) return errorResult("No quota windows in OpenCode Go usage response.");
    return { ok: true, windows };
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      return errorResult("OpenCode Go: unauthorized - API key rejected, re-authenticate.");
    }
    if (error instanceof HttpError && error.status === 403) {
      return errorResult("OpenCode Go: no subscription on this key (HTTP 403).");
    }
    return errorResult(describe(error, "OpenCode Go"));
  }
}
