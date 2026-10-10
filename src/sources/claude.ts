/**
 * Claude usage for every Claude account connected in OpenCode.
 *
 * Accounts live in the OpenCode credential store (opencode.db, table
 * "credential", integration id "anthropic") and their OAuth rotation is owned
 * by the anthropic auth plugin (ex-machina) - this source only reads the
 * current snapshot. On a 401 it re-reads the store once (the token may have
 * been rotated mid-query) and retries.
 *
 * Rate limits: honor Retry-After when present, otherwise exponential backoff
 * (max 15 min), tracked per account. While cooling down, serve that account's
 * last good data.
 */

import { clampPct, fetchJson, HttpError } from "./http";
import { readOpencodeClaudeAccounts, type OpencodeClaudeAccount } from "./auth";
import {
  errorResult,
  missingResult,
  type ClaudeAccountUsage,
  type QuotaResult,
  type UsageWindow,
} from "./types";
import { describe } from "./codex";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
// The endpoint throttles unknown user agents - identify as the official client.
const USER_AGENT = "claude-code/2.1.0";
const RATE_LIMIT_BACKOFF_BASE_MS = 30_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60_000;
/** Minimum gap between HTTP usage calls for one account (matches the refresh cadence). */
const HTTP_MIN_INTERVAL_MS = 60_000;

/** an***@example.org - local part clipped, domain kept. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

/** Per-account throttle + last-good cache. */
interface AccountRuntime {
  lastGood?: UsageWindow[];
  lastHttpAt: number;
  rateLimitedUntil: number;
  rateLimitFailures: number;
}

const runtimes = new Map<string, AccountRuntime>();

function runtimeOf(id: string): AccountRuntime {
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = { lastHttpAt: 0, rateLimitedUntil: 0, rateLimitFailures: 0 };
    runtimes.set(id, runtime);
  }
  return runtime;
}

function noteRateLimited(runtime: AccountRuntime, retryAfterMs?: number, now = Date.now()): number {
  // Trust the server's Retry-After when provided; only fall back to our own
  // exponential penalty when the server gives no guidance.
  const waitMs =
    retryAfterMs && retryAfterMs > 0
      ? Math.min(RATE_LIMIT_BACKOFF_MAX_MS, retryAfterMs)
      : Math.min(
          RATE_LIMIT_BACKOFF_MAX_MS,
          RATE_LIMIT_BACKOFF_BASE_MS * 2 ** Math.min(runtime.rateLimitFailures, 10),
        );
  if (!retryAfterMs || retryAfterMs <= 0) runtime.rateLimitFailures += 1;
  runtime.rateLimitedUntil = now + waitMs;
  return waitMs;
}

// ---------------------------------------------------------------------------
// Usage fetch
// ---------------------------------------------------------------------------

interface AnthropicUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  /** Max accounts report the weekly cap under the OAuth apps window. */
  seven_day_oauth_apps?: { utilization?: number; resets_at?: string };
}

function parseWindow(
  window: { utilization?: number; used_percent?: number; resets_at?: string } | undefined | null,
  label: string,
): UsageWindow | undefined {
  if (!window) return undefined;
  const used =
    typeof window.utilization === "number"
      ? window.utilization
      : typeof window.used_percent === "number"
        ? window.used_percent
        : undefined;
  if (used === undefined || !Number.isFinite(used)) return undefined;
  const ms = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
  return {
    label,
    usedPct: clampPct(used),
    resetsAt: Number.isFinite(ms) ? new Date(ms).toISOString() : undefined,
  };
}

function parseWindows(data: AnthropicUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const fiveHour = parseWindow(data.five_hour, "5h");
  const sevenDay = parseWindow(data.seven_day ?? data.seven_day_oauth_apps, "7d");
  if (fiveHour) windows.push(fiveHour);
  if (sevenDay) windows.push(sevenDay);
  return windows;
}

async function fetchUsage(token: string): Promise<UsageWindow[]> {
  const data = await fetchJson<AnthropicUsageResponse>(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": BETA_HEADER,
      "user-agent": USER_AGENT,
    },
  });
  const windows = parseWindows(data);
  if (windows.length === 0) throw new Error("No quota windows in Claude usage response.");
  return windows;
}

// ---------------------------------------------------------------------------
// Per-account query
// ---------------------------------------------------------------------------

interface AccountOutcome extends ClaudeAccountUsage {
  /** Severity when the account has no data at all. */
  kind: "ok" | "missing" | "error";
  /** Epoch ms until retry when serving cached data due to 429. */
  limitedUntil?: number;
}

function outcome(
  account: OpencodeClaudeAccount,
  label: string,
  kind: AccountOutcome["kind"],
  windows: readonly UsageWindow[],
  message?: string,
  limitedUntil?: number,
): AccountOutcome {
  return { label, active: account.active, kind, windows, message, limitedUntil };
}

async function queryClaudeAccount(
  account: OpencodeClaudeAccount,
  index: number,
): Promise<AccountOutcome> {
  const label = account.email ? maskEmail(account.email) : `Account ${index + 1}`;
  const runtime = runtimeOf(account.id);
  const now = Date.now();

  // The auth plugin owns rotation; a token known to be expired on disk should
  // not be sent at all (it would just 401).
  if (account.expires !== undefined && account.expires <= now) {
    return runtime.lastGood
      ? outcome(
          account,
          label,
          "ok",
          runtime.lastGood,
          "Claude: OAuth token expired - reconnect the account in OpenCode.",
        )
      : outcome(
          account,
          label,
          "missing",
          [],
          "Claude: OAuth token expired - reconnect the account in OpenCode.",
        );
  }

  const remainingMs = runtime.rateLimitedUntil - now;
  if (remainingMs > 0) {
    // Don't shoot while rate-limited: serve this account's last good data.
    if (runtime.lastGood) {
      return outcome(account, label, "ok", runtime.lastGood, undefined, runtime.rateLimitedUntil);
    }
    return outcome(
      account,
      label,
      "error",
      [],
      `Claude: rate limited, retry in ${Math.max(1, Math.ceil(remainingMs / 60_000))}m.`,
      runtime.rateLimitedUntil,
    );
  }

  // Healthy throttle: keep at least HTTP_MIN_INTERVAL_MS between calls.
  if (runtime.lastGood && now - runtime.lastHttpAt < HTTP_MIN_INTERVAL_MS) {
    return outcome(account, label, "ok", runtime.lastGood);
  }

  try {
    runtime.lastHttpAt = now;
    const windows = await fetchUsage(account.accessToken);
    runtime.rateLimitFailures = 0;
    runtime.rateLimitedUntil = 0;
    runtime.lastGood = windows;
    return outcome(account, label, "ok", windows);
  } catch (error) {
    // A 401 usually means our snapshot went stale mid-query (the auth plugin
    // rotated the token): re-read the store once and retry with the new token.
    if (error instanceof HttpError && error.status === 401) {
      const rotated = (await readOpencodeClaudeAccounts(true)).find((a) => a.id === account.id);
      if (rotated && rotated.accessToken !== account.accessToken) {
        try {
          runtime.lastHttpAt = Date.now();
          const windows = await fetchUsage(rotated.accessToken);
          runtime.rateLimitFailures = 0;
          runtime.rateLimitedUntil = 0;
          runtime.lastGood = windows;
          return outcome(account, label, "ok", windows);
        } catch (retryError) {
          error = retryError;
        }
      }
    }

    if (error instanceof HttpError && error.status === 429) {
      const waitMs = noteRateLimited(runtime, error.retryAfterMs);
      if (runtime.lastGood) {
        return outcome(
          account,
          label,
          "ok",
          runtime.lastGood,
          undefined,
          runtime.rateLimitedUntil,
        );
      }
      const wait = waitMs >= 60_000 ? `${Math.round(waitMs / 60_000)}m` : `${Math.round(waitMs / 1000)}s`;
      return outcome(
        account,
        label,
        "error",
        [],
        `Claude: rate limited, retry in ${wait}.`,
        runtime.rateLimitedUntil,
      );
    }
    if (error instanceof HttpError && error.status === 401) {
      return outcome(
        account,
        label,
        "error",
        [],
        "Claude: unauthorized - token expired, re-authenticate.",
      );
    }
    return outcome(account, label, "error", [], describe(error, "Claude"));
  }
}

// ---------------------------------------------------------------------------
// Aggregate query
// ---------------------------------------------------------------------------

export async function queryClaude(): Promise<QuotaResult> {
  const accounts = await readOpencodeClaudeAccounts();
  if (accounts.length === 0) {
    return missingResult("No Claude account connected in OpenCode - connect one via /connect.");
  }

  const outcomes = await Promise.all(
    accounts.map((account, index) => queryClaudeAccount(account, index)),
  );

  const accountUsages: ClaudeAccountUsage[] = outcomes.map((outcome) => ({
    label: outcome.label,
    active: outcome.active,
    windows: outcome.windows,
    message: outcome.message,
  }));

  // Primary = first account with data (active account sorts first).
  const primary = outcomes.find((outcome) => outcome.windows.length > 0);
  if (primary) {
    return {
      ok: true,
      windows: [...primary.windows],
      accounts: accountUsages,
      limitedUntil: primary.limitedUntil,
    };
  }

  const firstError = outcomes.find((outcome) => outcome.kind === "error");
  if (firstError?.message) return errorResult(firstError.message);
  return missingResult(
    outcomes[0]?.message ?? "No Claude account connected in OpenCode - connect one via /connect.",
  );
}
