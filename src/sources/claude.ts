/**
 * Claude Code usage.
 *
 * Strategy (mirrors opencode-quota):
 * 1. Probe the Claude CLI: `claude auth status --json` confirms login and the
 *    subscription tier. Newer CLI versions may include quota windows directly.
 * 2. Fall back to https://api.anthropic.com/api/oauth/usage (the same endpoint
 *    the interactive `/usage` command uses) with the OAuth token from
 *    OpenCode auth.json or ~/.claude/.credentials.json.
 *
 * The usage endpoint rate-limits (HTTP 429) and sends Retry-After - we honor
 * it and back off instead of hammering.
 */

import { execFile } from "node:child_process";
import { claudeOAuthToken, opencodeAuthEntry } from "./auth";
import { clampPct, fetchJson, HttpError } from "./http";
import { errorResult, missingResult, type QuotaResult, type UsageWindow } from "./types";
import { describe } from "./codex";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_COMMAND_TIMEOUT_MS = 4_000;
const RATE_LIMIT_BACKOFF_BASE_MS = 30_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60_000;
/** Minimum gap between HTTP usage calls (Claude throttles aggressive polling). */
const HTTP_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * The usage endpoint 429s when polled too aggressively; honor Retry-After and
 * back off exponentially instead of hammering it every refresh.
 */
let rateLimitedUntil = 0;
let rateLimitFailures = 0;

function rateLimitRemainingMs(now = Date.now()): number {
  return Math.max(0, rateLimitedUntil - now);
}

function noteRateLimited(retryAfterMs?: number, now = Date.now()): number {
  // Trust the server's Retry-After when provided; only fall back to our own
  // exponential penalty when the server gives no guidance.
  const waitMs =
    retryAfterMs && retryAfterMs > 0
      ? Math.min(RATE_LIMIT_BACKOFF_MAX_MS, retryAfterMs)
      : Math.min(
          RATE_LIMIT_BACKOFF_MAX_MS,
          RATE_LIMIT_BACKOFF_BASE_MS * 2 ** Math.min(rateLimitFailures, 10),
        );
  if (!retryAfterMs || retryAfterMs <= 0) rateLimitFailures += 1;
  rateLimitedUntil = now + waitMs;
  return waitMs;
}

/** Last successful usage - served (flagged) while the API is rate-limiting us. */
let lastGood: { plan?: string; windows: UsageWindow[] } | undefined;
let lastHttpAt = 0;

// ---------------------------------------------------------------------------
// CLI probe
// ---------------------------------------------------------------------------

interface ClaudeCliPayload {
  loggedIn?: boolean;
  isAuthenticated?: boolean;
  subscriptionType?: string;
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  quota?: ClaudeCliPayload;
  usage?: ClaudeCliPayload;
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/\\+$/g, "$1$1")}"`;
}

function claudeInvocation(args: string[]): { file: string; args: string[] } {
  const binary = process.env["CLAUDE_BIN"]?.trim() || "claude";
  if (process.platform === "win32") {
    const comspec = process.env["ComSpec"]?.trim() || "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", [binary, ...args].map(quoteWindowsArg).join(" ")].map(String) };
  }
  return { file: binary, args };
}

function runClaude(args: string[]): Promise<{ code: number; stdout: string }> {
  const invocation = claudeInvocation(args);
  return new Promise((resolve) => {
    execFile(
      invocation.file,
      invocation.args,
      { encoding: "utf8", timeout: CLAUDE_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const execError = error as (Error & { code?: number | string }) | null;
        resolve({
          code: error ? (typeof execError?.code === "number" ? execError.code : 1) : 0,
          stdout: `${stdout ?? ""}\n${stderr ?? ""}`,
        });
      },
    );
  });
}

interface CliProbe {
  available: boolean; // CLI exists and ran
  loggedIn?: boolean;
  plan?: string;
  version?: string;
  windows?: UsageWindow[];
}

function parseWindow(
  window: { utilization?: number; used_percent?: number; resets_at?: string } | undefined,
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

function planLabel(subscriptionType: unknown): string | undefined {
  if (typeof subscriptionType !== "string" || !subscriptionType.trim()) return undefined;
  return subscriptionType.trim().charAt(0).toUpperCase() + subscriptionType.trim().slice(1);
}

async function probeCli(): Promise<CliProbe> {
  const version = await runClaude(["--version"]);
  if (/not recognized|command not found|no such file/i.test(version.stdout)) {
    return { available: false };
  }
  // e.g. "2.1.258 (Claude Code)" -> "2.1.258"
  const versionString = version.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];

  const status = await runClaude(["auth", "status", "--json"]);
  const trimmed = status.stdout.trim();
  let payload: ClaudeCliPayload | undefined;
  try {
    payload = JSON.parse(trimmed.startsWith("{") ? trimmed : trimmed.slice(trimmed.indexOf("{"))) as ClaudeCliPayload;
  } catch {
    return { available: true, loggedIn: status.code === 0 ? true : undefined };
  }

  const root = payload ?? {};
  const source = root.quota ?? root.usage ?? root;
  const loggedIn = typeof root.loggedIn === "boolean" ? root.loggedIn : undefined;

  const windows: UsageWindow[] = [];
  const fiveHour = parseWindow(source.five_hour, "5h");
  const sevenDay = parseWindow(source.seven_day, "7d");
  if (fiveHour) windows.push(fiveHour);
  if (sevenDay) windows.push(sevenDay);

  return {
    available: true,
    loggedIn,
    plan: planLabel(root.subscriptionType),
    version: versionString,
    windows: windows.length > 0 ? windows : undefined,
  };
}

// ---------------------------------------------------------------------------
// OAuth token resolution
// ---------------------------------------------------------------------------

async function resolveToken(): Promise<string | undefined> {
  const envToken = await claudeOAuthToken();
  if (envToken) return envToken;

  const entry = await opencodeAuthEntry(["anthropic"]);
  const access = entry?.entry.access?.trim();
  if (access && entry && (!entry.entry.type || entry.entry.type === "oauth")) return access;

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function queryClaude(): Promise<QuotaResult> {
  const cli = await probeCli();
  if (cli.available && cli.loggedIn === false) {
    return missingResult("Claude is not authenticated - run `claude /login`.");
  }
  // Anthropic throttles this endpoint for unknown user agents - identify as
  // the official Claude Code client (same trick as CodexBar).
  const userAgent = `claude-code/${cli.version ?? "2.1.0"}`;

  const cliPlan = cli.plan;
  if (cli.windows && cli.windows.length > 0) {
    return { ok: true, plan: cliPlan, windows: cli.windows };
  }

  const token = await resolveToken();
  if (!token) {
    if (cli.available && cli.loggedIn) {
      return missingResult("Claude CLI is authenticated but no OAuth token is exposed for usage queries.");
    }
    return missingResult(
      "No Claude OAuth token found (sign in via `claude` or /connect). API keys have no usage data.",
    );
  }

  const remainingMs = rateLimitRemainingMs();
  if (remainingMs > 0) {
    // Don't shoot while rate-limited: serve the last good data, flagged.
    if (lastGood) return { ok: true, plan: lastGood.plan, windows: lastGood.windows, limitedUntil: rateLimitedUntil };
    return {
      ok: false,
      kind: "error",
      message: `Claude: rate limited, retry in ${Math.max(1, Math.ceil(remainingMs / 60_000))}m.`,
      limitedUntil: rateLimitedUntil,
    };
  }

  // Healthy throttle: the usage endpoint dislikes aggressive polling, so keep
  // at least HTTP_MIN_INTERVAL_MS between HTTP calls.
  if (lastGood && Date.now() - lastHttpAt < HTTP_MIN_INTERVAL_MS) {
    return {
      ok: true,
      plan: lastGood.plan,
      windows: lastGood.windows,
      cacheUntil: lastHttpAt + HTTP_MIN_INTERVAL_MS,
    };
  }

  try {
    lastHttpAt = Date.now();
    const data = await fetchJson<{ five_hour?: { utilization?: number; resets_at?: string }; seven_day?: { utilization?: number; resets_at?: string } }>(
      USAGE_URL,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": BETA_HEADER,
          "user-agent": userAgent,
        },
      },
    );
    rateLimitFailures = 0;
    rateLimitedUntil = 0;
    const windows: UsageWindow[] = [];
    const fiveHour = parseWindow(data.five_hour, "5h");
    const sevenDay = parseWindow(data.seven_day, "7d");
    if (fiveHour) windows.push(fiveHour);
    if (sevenDay) windows.push(sevenDay);
    if (windows.length === 0) return errorResult("No quota windows in Claude usage response.");
    lastGood = { plan: cliPlan, windows };
    return { ok: true, plan: cliPlan, windows };
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      const waitMs = noteRateLimited(error.retryAfterMs);
      const source = error.retryAfterMs && error.retryAfterMs > 0 ? "server" : "backoff";
      if (lastGood) return { ok: true, plan: lastGood.plan, windows: lastGood.windows, limitedUntil: rateLimitedUntil };
      const wait = waitMs >= 60_000 ? `${Math.round(waitMs / 60_000)}m` : `${Math.round(waitMs / 1000)}s`;
      return {
        ok: false,
        kind: "error",
        message: `Claude: rate limited, retry in ${wait} (${source}).`,
        limitedUntil: rateLimitedUntil,
      };
    }
    return errorResult(describe(error, "Claude"));
  }
}
