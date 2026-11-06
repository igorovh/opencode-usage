// @bun
// src/tui.tsx
import { memo as _$memo } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show } from "solid-js";

// src/format.ts
function renderBar(usedPct, width = 10) {
  const clamped = Math.min(100, Math.max(0, usedPct));
  const filled = Math.round(clamped / 100 * width);
  return "\u2501".repeat(filled) + "\u2500".repeat(width - filled);
}
function formatReset(resetsAt, now = Date.now()) {
  if (!resetsAt)
    return "";
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target) || target <= now)
    return "";
  return formatDuration(target - now);
}
function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes % 1440 / 60);
  const minutes = totalMinutes % 60;
  if (days > 0)
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
}
function shortStatus(message) {
  if (!message)
    return "not connected";
  if (/HTTP 429|rate limit/i.test(message)) {
    const wait = message.match(/retry in (\d+[ms])/i)?.[1];
    return wait ? `rate limited (${wait})` : "rate limited";
  }
  if (/no subscription|entitlement|forbidden|HTTP 403/i.test(message))
    return "no subscription";
  if (/HTTP 401|unauthorized|expired/i.test(message))
    return "login required";
  if (/timed out|timeout/i.test(message))
    return "timeout";
  if (/No .* token|connect|env/i.test(message))
    return "not connected";
  return truncate(message, 24);
}

// src/options.ts
var PROVIDER_IDS = ["codex", "claude", "glm", "opencode-go"];
var DEFAULT_REFRESH_MS = 60000;
var MIN_REFRESH_MS = 15000;
function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function parseOptions(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const refresh = input["refreshMs"];
  const providers = input["providers"] && typeof input["providers"] === "object" ? input["providers"] : {};
  return {
    refreshMs: typeof refresh === "number" && Number.isFinite(refresh) ? Math.max(MIN_REFRESH_MS, refresh) : DEFAULT_REFRESH_MS,
    sidebar: bool(input["sidebar"], true),
    footer: bool(input["footer"], true),
    home: bool(input["home"], true),
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, bool(providers[id], true)])),
    goApiKey: text(input["goApiKey"]) ?? text(input["apiKey"]),
    goBaseUrl: text(input["goBaseUrl"]),
    claudeUserAgent: text(input["claudeUserAgent"]),
    log: bool(input["log"], false)
  };
}

// src/sources/auth.ts
import { execFile } from "child_process";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir, userInfo } from "os";
import { join } from "path";
var CACHE_TTL_MS = 5000;
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function firstString(value, keys) {
  const record = asRecord(value);
  if (!record)
    return;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return;
}
function opencodeDataDir() {
  const xdg = process.env["XDG_DATA_HOME"]?.trim();
  return join(xdg || join(homedir(), ".local", "share"), "opencode");
}
var credentialLister;
var credentialCache;
function setCredentialLister(lister) {
  credentialLister = lister;
  credentialCache = undefined;
}
function opencodeDbPath() {
  return process.env["OPENCODE_DB"]?.trim() || join(opencodeDataDir(), "opencode.db");
}
async function readCredentialRows() {
  const path = opencodeDbPath();
  if (!existsSync(path))
    return [];
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.query("select id, integration_id, label, value, active from credential").all();
      return rows.flatMap((row) => {
        try {
          const value = asRecord(JSON.parse(row.value));
          if (!value)
            return [];
          return [{
            id: row.id,
            integrationID: row.integration_id,
            label: row.label ?? "",
            active: row.active === 1,
            value
          }];
        } catch {
          return [];
        }
      });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
async function listCredentials(force = false) {
  const now = Date.now();
  if (!force && credentialCache && now - credentialCache.at < CACHE_TTL_MS)
    return credentialCache.value;
  let value;
  if (credentialLister) {
    try {
      value = await credentialLister();
    } catch {}
  }
  value ??= await readCredentialRows();
  credentialCache = { at: now, value };
  return value;
}
async function credentialsFor(integrationIds) {
  const all = await listCredentials();
  for (const id of integrationIds) {
    const matches = all.filter((credential) => credential.integrationID === id);
    if (matches.length > 0)
      return matches.sort((a, b) => Number(b.active) - Number(a.active));
  }
  return [];
}
function credentialKey(credential) {
  return credential.value["type"] === "key" ? firstString(credential.value, ["key"]) : undefined;
}
function credentialOAuth(credential) {
  if (credential.value["type"] !== "oauth")
    return;
  const access = firstString(credential.value, ["access"]);
  if (!access)
    return;
  const expires = credential.value["expires"];
  return {
    access,
    refresh: firstString(credential.value, ["refresh"]),
    expires: typeof expires === "number" ? expires : undefined,
    metadata: asRecord(credential.value["metadata"])
  };
}
var legacyAuthCache;
async function readLegacyAuth() {
  const now = Date.now();
  if (legacyAuthCache && now - legacyAuthCache.at < CACHE_TTL_MS)
    return legacyAuthCache.value;
  let value = null;
  try {
    value = asRecord(JSON.parse(await readFile(join(opencodeDataDir(), "auth.json"), "utf8"))) ?? null;
  } catch {}
  legacyAuthCache = { at: now, value };
  return value;
}
async function legacyAuthEntry(providerIds) {
  const auth = await readLegacyAuth();
  if (!auth)
    return;
  for (const id of providerIds) {
    const entry = asRecord(auth[id]);
    if (entry)
      return { id, entry };
  }
  return;
}
var claudeAccountsCache;
function emailFromLabel(label) {
  if (typeof label !== "string")
    return;
  return label.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
}
function claudeConfigDir() {
  return process.env["CLAUDE_CONFIG_DIR"]?.trim() || undefined;
}
function claudeKeychainService() {
  const dir = claudeConfigDir();
  if (!dir)
    return "Claude Code-credentials";
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}
function readKeychainSecret(service) {
  return new Promise((resolve) => {
    execFile("security", ["find-generic-password", "-a", userInfo().username, "-s", service, "-w"], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
}
async function readClaudeCodeLogin() {
  const candidates = [];
  if (process.platform === "darwin")
    candidates.push(() => readKeychainSecret(claudeKeychainService()));
  const file = join(claudeConfigDir() ?? join(homedir(), ".claude"), ".credentials.json");
  candidates.push(() => readFile(file, "utf8").catch(() => {
    return;
  }));
  for (const read of candidates) {
    const content = await read();
    if (!content)
      continue;
    try {
      const oauth = asRecord(asRecord(JSON.parse(content))?.["claudeAiOauth"]);
      if (firstString(oauth, ["accessToken"]))
        return oauth;
    } catch {}
  }
  return;
}
async function readClaudeCodeEmail() {
  const file = join(claudeConfigDir() ?? homedir(), ".claude.json");
  try {
    const parsed = asRecord(JSON.parse(await readFile(file, "utf8")));
    return firstString(asRecord(parsed?.["oauthAccount"]), ["emailAddress"]);
  } catch {
    return;
  }
}
async function readClaudeAgentAccount(credential) {
  const oauth = await readClaudeCodeLogin();
  const access = firstString(oauth, ["accessToken"]);
  if (!access)
    return;
  return {
    id: credential.id,
    source: "claude-agent",
    email: await readClaudeCodeEmail() ?? emailFromLabel(credential.label),
    accessToken: access,
    expires: typeof oauth?.["expiresAt"] === "number" ? oauth["expiresAt"] : undefined,
    active: true
  };
}
function anthropicAccount(credential) {
  const oauth = credentialOAuth(credential);
  if (!oauth)
    return;
  return {
    id: credential.id,
    source: "anthropic",
    email: emailFromLabel(credential.label),
    accessToken: oauth.access,
    expires: oauth.expires,
    active: credential.active
  };
}
async function readOpencodeClaudeAccounts(force = false) {
  const now = Date.now();
  if (!force && claudeAccountsCache && now - claudeAccountsCache.at < CACHE_TTL_MS) {
    return claudeAccountsCache.value;
  }
  const all = await listCredentials(force);
  const agent = all.find((credential) => credential.integrationID === "claude-agent");
  let value;
  if (agent) {
    const account = await readClaudeAgentAccount(agent);
    value = { agent: true, accounts: account ? [account] : [] };
  } else {
    const accounts = all.filter((credential) => credential.integrationID === "anthropic").map(anthropicAccount).filter((account) => !!account);
    accounts.sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));
    value = { agent: false, accounts };
  }
  claudeAccountsCache = { at: now, value };
  return value;
}
async function codexCliTokens() {
  const codexHome = process.env["CODEX_HOME"]?.trim() || join(homedir(), ".codex");
  try {
    const content = await readFile(join(codexHome, "auth.json"), "utf8");
    const tokens = asRecord(asRecord(JSON.parse(content))?.["tokens"]);
    const accessToken = firstString(tokens, ["access_token"]);
    if (!accessToken)
      return;
    return { accessToken, accountId: firstString(tokens, ["account_id"]) };
  } catch {
    return;
  }
}
function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}
function parseOpenAiJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3)
      return;
    return asRecord(JSON.parse(base64UrlDecode(parts[1])));
  } catch {
    return;
  }
}
function stringField(value, key) {
  return firstString(value, [key]);
}

// src/sources/log.ts
import { appendFile, mkdir, rename, stat } from "fs/promises";
import { dirname, join as join2 } from "path";
var MAX_LOG_BYTES = 1024 * 1024;
var enabled = false;
var writes = Promise.resolve();
function setUsageLog(on) {
  enabled = on;
}
function usageLogPath() {
  return join2(opencodeDataDir(), "log", "usage-plugin.log");
}
async function append(entry) {
  const path = usageLogPath();
  await mkdir(dirname(path), { recursive: true });
  const size = await stat(path).then((info) => info.size, () => 0);
  if (size >= MAX_LOG_BYTES)
    await rename(path, `${path}.1`);
  await appendFile(path, entry, "utf8");
}
function writeUsageLog(line) {
  if (!enabled)
    return;
  const entry = JSON.stringify({ ts: new Date().toISOString(), ...line }) + `
`;
  writes = writes.then(() => append(entry)).catch(() => {});
}

// src/sources/http.ts
class HttpError extends Error {
  status;
  retryAfterMs;
  constructor(status, url, retryAfterMs) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
function parseRetryAfter(value) {
  if (!value?.trim())
    return;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0)
    return seconds * 1000;
  const at = Date.parse(value);
  if (Number.isFinite(at))
    return Math.max(0, at - Date.now());
  return;
}
async function fetchJson(url, options = {}) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1e4);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...options.headers },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new HttpError(response.status, url, parseRetryAfter(response.headers.get("retry-after")));
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HttpError)
      throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out: ${url}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}
var DEFAULT_RATE_LIMIT_MS = 5 * 60000;
var MAX_RATE_LIMIT_MS = 30 * 60000;
function describe(error, provider) {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401/.test(message))
    return `${provider}: unauthorized - token expired, re-authenticate.`;
  if (/HTTP 403/.test(message))
    return `${provider}: forbidden - no subscription or access (HTTP 403).`;
  return `${provider}: ${message}`;
}
function rateLimitedUntil(error, now = Date.now()) {
  if (!(error instanceof HttpError) || error.status !== 429)
    return;
  const wait = error.retryAfterMs && error.retryAfterMs > 0 ? error.retryAfterMs : DEFAULT_RATE_LIMIT_MS;
  return now + Math.min(MAX_RATE_LIMIT_MS, wait);
}
function formatWait(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}
function clampPct(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(100, Math.max(0, n));
}
function toIso(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return;
  const ms = value < 10000000000 ? value * 1000 : value;
  const date = new Date(Math.round(ms));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function isoFromNowPlusSeconds(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
    return;
  return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
}

// src/sources/types.ts
function errorResult(message, limitedUntil) {
  return { ok: false, kind: "error", message, limitedUntil };
}
function missingResult(message) {
  return { ok: false, kind: "missing", message };
}

// src/sources/claude.ts
var USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
var BETA_HEADER = "oauth-2025-04-20";
var DEFAULT_CLAUDE_USER_AGENT = "claude-code/2.1.0";
var userAgent = DEFAULT_CLAUDE_USER_AGENT;
function setClaudeUserAgent(value) {
  userAgent = value?.trim() || DEFAULT_CLAUDE_USER_AGENT;
}
var RATE_LIMIT_BACKOFF_BASE_MS = 30000;
var RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60000;
var HTTP_MIN_INTERVAL_MS = 60000;
function maskEmail(email) {
  const at = email.indexOf("@");
  if (at <= 0)
    return "***";
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
var runtimes = new Map;
function runtimeOf(id) {
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = { lastHttpAt: 0, rateLimitedUntil: 0, rateLimitFailures: 0 };
    runtimes.set(id, runtime);
  }
  return runtime;
}
function noteRateLimited(runtime, retryAfterMs, now = Date.now()) {
  const waitMs = retryAfterMs && retryAfterMs > 0 ? Math.min(RATE_LIMIT_BACKOFF_MAX_MS, retryAfterMs) : Math.min(RATE_LIMIT_BACKOFF_MAX_MS, RATE_LIMIT_BACKOFF_BASE_MS * 2 ** Math.min(runtime.rateLimitFailures, 10));
  if (!retryAfterMs || retryAfterMs <= 0)
    runtime.rateLimitFailures += 1;
  runtime.rateLimitedUntil = now + waitMs;
  return waitMs;
}
function parseWindow(window, label) {
  if (!window)
    return;
  const used = typeof window.utilization === "number" ? window.utilization : typeof window.used_percent === "number" ? window.used_percent : undefined;
  if (used === undefined || !Number.isFinite(used))
    return;
  const ms = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
  return {
    label,
    usedPct: clampPct(used),
    resetsAt: Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
  };
}
function parseWindows(data) {
  const windows = [];
  const fiveHour = parseWindow(data.five_hour, "5h");
  const sevenDay = parseWindow(data.seven_day ?? data.seven_day_oauth_apps, "7d");
  if (fiveHour)
    windows.push(fiveHour);
  if (sevenDay)
    windows.push(sevenDay);
  return windows;
}
async function fetchUsage(token) {
  const data = await fetchJson(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": BETA_HEADER,
      "user-agent": userAgent
    }
  });
  const windows = parseWindows(data);
  if (windows.length === 0)
    throw new Error("No quota windows in Claude usage response.");
  return windows;
}
function outcome(account, label, kind, windows, message, limitedUntil) {
  return { label, active: account.active, kind, windows, message, limitedUntil };
}
async function queryClaudeAccount(account, index) {
  const label = account.email ? maskEmail(account.email) : `Account ${index + 1}`;
  const runtime = runtimeOf(account.id);
  const now = Date.now();
  if (account.expires !== undefined && account.expires <= now) {
    const message = account.source === "claude-agent" ? "Claude: OAuth token expired - Claude Agent refreshes it on its next request." : "Claude: OAuth token expired - reconnect the account in OpenCode.";
    return runtime.lastGood ? outcome(account, label, "ok", runtime.lastGood, message) : outcome(account, label, "missing", [], message);
  }
  const remainingMs = runtime.rateLimitedUntil - now;
  if (remainingMs > 0) {
    if (runtime.lastGood) {
      return outcome(account, label, "ok", runtime.lastGood, undefined, runtime.rateLimitedUntil);
    }
    return outcome(account, label, "error", [], `Claude: rate limited, retry in ${Math.max(1, Math.ceil(remainingMs / 60000))}m.`, runtime.rateLimitedUntil);
  }
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
    if (error instanceof HttpError && error.status === 401) {
      const rotated = (await readOpencodeClaudeAccounts(true)).accounts.find((a) => a.id === account.id);
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
        return outcome(account, label, "ok", runtime.lastGood, undefined, runtime.rateLimitedUntil);
      }
      const wait = formatWait(waitMs);
      return outcome(account, label, "error", [], `Claude: rate limited, retry in ${wait}.`, runtime.rateLimitedUntil);
    }
    if (error instanceof HttpError && error.status === 401) {
      return outcome(account, label, "error", [], "Claude: unauthorized - token expired, re-authenticate.");
    }
    return outcome(account, label, "error", [], describe(error, "Claude"));
  }
}
async function queryClaude() {
  const { agent, accounts } = await readOpencodeClaudeAccounts();
  if (accounts.length === 0) {
    return missingResult(agent ? "Claude Agent is connected but no Claude Code login was found - run `claude /login`." : "No Claude account connected in OpenCode - connect one via /connect.");
  }
  const outcomes = await Promise.all(accounts.map((account, index) => queryClaudeAccount(account, index)));
  const accountUsages = outcomes.map((outcome) => ({
    label: outcome.label,
    active: outcome.active,
    windows: outcome.windows,
    message: outcome.message
  }));
  const primary = outcomes.find((outcome) => outcome.windows.length > 0);
  if (primary) {
    return {
      ok: true,
      windows: [...primary.windows],
      accounts: accountUsages,
      limitedUntil: primary.limitedUntil
    };
  }
  const firstError = outcomes.find((outcome) => outcome.kind === "error");
  if (firstError?.message)
    return errorResult(firstError.message, firstError.limitedUntil);
  return missingResult(outcomes[0]?.message ?? "No Claude account connected in OpenCode - connect one via /connect.");
}

// src/sources/codex.ts
var USAGE_URL2 = "https://chatgpt.com/backend-api/wham/usage";
var OPENAI_IDS = ["openai"];
var USER_AGENT = "opencode-usage";
function windowLabel(limitWindowSeconds) {
  if (typeof limitWindowSeconds !== "number")
    return;
  if (limitWindowSeconds === 18000)
    return "5h";
  if (limitWindowSeconds === 604800)
    return "7d";
  if (limitWindowSeconds === 2628000)
    return "30d";
  const hours = Math.round(limitWindowSeconds / 3600);
  return hours > 0 ? `${hours}h` : undefined;
}
function usedFromWindow(window) {
  if (typeof window.used_percent === "number")
    return clampPct(window.used_percent);
  if (typeof window.remaining_percent === "number")
    return clampPct(100 - window.remaining_percent);
  return;
}
function resetFromWindow(window) {
  return toIso(window.reset_at) ?? isoFromNowPlusSeconds(window.reset_after_seconds);
}
function parseWindows2(response) {
  const windows = [];
  const seen = new Set;
  for (const window of [response.rate_limit?.primary_window, response.rate_limit?.secondary_window]) {
    if (!window)
      continue;
    const label = windowLabel(window.limit_window_seconds);
    const used = usedFromWindow(window);
    if (!label || used === undefined || seen.has(label))
      continue;
    seen.add(label);
    windows.push({ label, usedPct: used, resetsAt: resetFromWindow(window) });
  }
  return windows;
}
function accountIdFrom(token, fallback) {
  return parseOpenAiJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? fallback;
}
async function tokenCandidates() {
  const candidates = [];
  const now = Date.now();
  const cli = await codexCliTokens();
  if (cli)
    candidates.push(cli);
  for (const credential of await credentialsFor(OPENAI_IDS)) {
    const oauth = credentialOAuth(credential);
    if (!oauth || oauth.expires !== undefined && oauth.expires < now)
      continue;
    candidates.push({
      accessToken: oauth.access,
      accountId: accountIdFrom(oauth.access, stringField(oauth.metadata, "accountID"))
    });
  }
  const legacy = await legacyAuthEntry(OPENAI_IDS);
  const access = legacy?.entry.type === "oauth" ? legacy.entry.access?.trim() : undefined;
  const expired = typeof legacy?.entry.expires === "number" && legacy.entry.expires < now;
  if (access && !expired)
    candidates.push({ accessToken: access, accountId: accountIdFrom(access, legacy?.entry.accountId) });
  const seen = new Set;
  return candidates.filter((candidate) => !seen.has(candidate.accessToken) && !!seen.add(candidate.accessToken));
}
async function queryCodex() {
  const candidates = await tokenCandidates();
  if (candidates.length === 0) {
    return missingResult("No Codex/ChatGPT OAuth token found (connect ChatGPT via /connect or run `codex login`).");
  }
  let lastError;
  for (const tokens of candidates) {
    for (let attempt = 0;attempt < 2; attempt++) {
      try {
        const headers = {
          authorization: `Bearer ${tokens.accessToken}`,
          "user-agent": USER_AGENT
        };
        if (tokens.accountId)
          headers["chatgpt-account-id"] = tokens.accountId;
        const data = await fetchJson(USAGE_URL2, { headers });
        const windows = parseWindows2(data);
        if (windows.length === 0)
          return errorResult("No quota windows in Codex usage response.");
        const plan = data.plan_type ? capitalize(data.plan_type) : undefined;
        return { ok: true, plan, windows };
      } catch (error) {
        const limitedUntil = rateLimitedUntil(error);
        if (limitedUntil)
          return errorResult("Codex: rate limited (HTTP 429).", limitedUntil);
        lastError = describe(error, "Codex");
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
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
function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// src/sources/glm.ts
var ZAI_BASE = "https://api.z.ai";
var ZHIPU_BASE = "https://bigmodel.cn";
function unitLabel(unit) {
  if (unit === 3)
    return "5h";
  if (unit === 6)
    return "7d";
  return;
}
function parseWindows3(body, platform) {
  if (platform === "zai" && (body.success === false || typeof body.code === "number" && body.code >= 400)) {
    throw new Error(body.msg || `GLM API error ${body.code ?? ""}`.trim());
  }
  const limits = body.data?.limits ?? body.limits;
  if (!Array.isArray(limits))
    throw new Error("Invalid GLM quota response shape.");
  const windows = [];
  for (const limit of limits) {
    const isQuota = limit.type === "TOKENS_LIMIT" || limit.type === "CREDIT_LIMIT";
    if (!isQuota)
      continue;
    const label = unitLabel(limit.unit);
    if (!label || typeof limit.percentage !== "number")
      continue;
    windows.push({
      label,
      usedPct: clampPct(limit.percentage),
      resetsAt: toIso(limit.nextResetTime)
    });
  }
  return windows;
}
var GLM_IDS = ["zai-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"];
function platformAuth(apiKey, platform) {
  return { apiKey, base: platform === "zai" ? ZAI_BASE : ZHIPU_BASE, platform };
}
async function resolveGlmAuth() {
  for (const id of GLM_IDS) {
    const credential = (await credentialsFor([id]))[0];
    const apiKey = credential ? credentialKey(credential) : (await legacyAuthEntry([id]))?.entry.key?.trim();
    if (apiKey)
      return platformAuth(apiKey, id === "zai-coding-plan" ? "zai" : "zhipu");
  }
  const zaiEnv = process.env["ZAI_API_KEY"]?.trim() || process.env["ZAI_CODING_PLAN_API_KEY"]?.trim();
  if (zaiEnv)
    return platformAuth(zaiEnv, "zai");
  const zhipuEnv = process.env["ZHIPU_API_KEY"]?.trim() || process.env["ZHIPU_CODING_PLAN_API_KEY"]?.trim();
  if (zhipuEnv)
    return platformAuth(zhipuEnv, "zhipu");
  return;
}
async function queryGlm() {
  const auth = await resolveGlmAuth();
  if (!auth) {
    return missingResult("No GLM Coding Plan key found (/connect Z.AI Coding Plan, or set ZAI_API_KEY / ZHIPU_API_KEY).");
  }
  try {
    const body = await fetchJson(`${auth.base}/api/monitor/usage/quota/limit`, {
      headers: {
        authorization: auth.apiKey,
        "content-type": "application/json"
      }
    });
    const windows = parseWindows3(body, auth.platform);
    if (windows.length === 0)
      return errorResult("No quota windows in GLM usage response.");
    return { ok: true, windows };
  } catch (error) {
    const limitedUntil = rateLimitedUntil(error);
    if (limitedUntil)
      return errorResult("GLM: rate limited (HTTP 429).", limitedUntil);
    return errorResult(describe(error, "GLM"));
  }
}

// src/sources/opencode-go.ts
var GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go";
var GO_TIMEOUT_MS = 15000;
function toWindow(window, label) {
  if (!window || typeof window.percent !== "number" || !Number.isFinite(window.percent)) {
    return;
  }
  const resetsAt = typeof window.resetsAt === "string" && !Number.isNaN(Date.parse(window.resetsAt)) ? window.resetsAt : undefined;
  return { label, usedPct: clampPct(window.percent), resetsAt };
}
function parseWindows4(body) {
  const windows = [];
  for (const [key, label] of [["rolling", "5h"], ["weekly", "7d"], ["monthly", "1m"]]) {
    const window = toWindow(body.usage?.[key], label);
    if (window)
      windows.push(window);
  }
  return windows;
}
async function resolveGoKey(explicit) {
  if (explicit?.trim())
    return explicit.trim();
  const fromEnv = process.env["OPENCODE_API_KEY"]?.trim();
  if (fromEnv)
    return fromEnv;
  for (const id of ["opencode-go", "opencode"]) {
    for (const credential of await credentialsFor([id])) {
      const key = credentialKey(credential);
      if (key)
        return key;
    }
  }
  const legacy = await legacyAuthEntry(["opencode-go", "opencode"]);
  return legacy?.entry.type === "api" || legacy?.entry.type === undefined ? legacy?.entry.key?.trim() || undefined : undefined;
}
function resolveBaseUrl(explicit) {
  const base = explicit?.trim() || GO_DEFAULT_BASE_URL;
  const stripped = base.replace(/\/+$/, "");
  const parsed = new URL(stripped);
  if (parsed.protocol === "https:")
    return stripped;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)) {
      return stripped;
    }
  }
  throw new Error(`OpenCode Go: baseUrl must use https (http only allowed for localhost).`);
}
async function queryOpencodeGo(overrides = {}) {
  const apiKey = await resolveGoKey(overrides.apiKey);
  if (!apiKey) {
    return missingResult("No OpenCode Go API key found (set OPENCODE_API_KEY or connect an OpenCode API key via /connect).");
  }
  let base;
  try {
    base = resolveBaseUrl(overrides.baseUrl);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
  try {
    const body = await fetchJson(`${base}/v1/usage`, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: GO_TIMEOUT_MS
    });
    const windows = parseWindows4(body);
    if (windows.length === 0)
      return errorResult("No quota windows in OpenCode Go usage response.");
    return { ok: true, windows };
  } catch (error) {
    const limitedUntil = rateLimitedUntil(error);
    if (limitedUntil)
      return errorResult("OpenCode Go: rate limited (HTTP 429).", limitedUntil);
    if (error instanceof HttpError && error.status === 401) {
      return errorResult("OpenCode Go: unauthorized - API key rejected, re-authenticate.");
    }
    if (error instanceof HttpError && error.status === 403) {
      return errorResult("OpenCode Go: no subscription on this key (HTTP 403).");
    }
    return errorResult(describe(error, "OpenCode Go"));
  }
}

// src/tui.tsx
var STALE_OK_MS = 10 * 60000;
var CLAUDE_BASE_INTERVAL_MS = 2 * 60000;
var CLAUDE_MAX_INTERVAL_MS = 15 * 60000;
var PROVIDERS = {
  codex: {
    label: "Codex",
    query: () => queryCodex()
  },
  claude: {
    label: "Claude",
    query: () => queryClaude()
  },
  glm: {
    label: "GLM",
    query: () => queryGlm()
  },
  "opencode-go": {
    label: "Go",
    query: (opts) => queryOpencodeGo({
      apiKey: opts.goApiKey,
      baseUrl: opts.goBaseUrl
    })
  }
};
var LABEL_WIDTH = Math.max(...PROVIDER_IDS.map((id) => PROVIDERS[id].label.length));
function initialSnapshot(id) {
  return {
    id,
    label: PROVIDERS[id].label,
    state: {
      status: "missing"
    },
    updatedAt: 0
  };
}
function initialState() {
  return {
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, initialSnapshot(id)]))
  };
}
function snapOf(state, id) {
  return state.providers[id] ?? initialSnapshot(id);
}
var WINDOW_ORDER = {
  "5h": 0,
  "7d": 1,
  "30d": 2,
  "1m": 2
};
function sortedWindows(windows) {
  return [...windows].sort((a, b) => (WINDOW_ORDER[a.label] ?? 9) - (WINDOW_ORDER[b.label] ?? 9));
}
function remaining(window) {
  return Math.min(100, Math.max(0, 100 - window.usedPct));
}
function feedbackFor(remainingPct) {
  if (remainingPct <= 20)
    return "error";
  if (remainingPct <= 50)
    return "warning";
  return "success";
}
function windowsOf(snapshot) {
  return snapshot.state.status === "ok" ? snapshot.state.windows : [];
}
function accountsOf(snapshot) {
  return snapshot.state.status === "ok" ? snapshot.state.accounts ?? [] : [];
}
function feedbackColor(ctx, window) {
  return ctx.theme.text.feedback[feedbackFor(remaining(window))].base;
}
function missingText(snapshot) {
  if (snapshot.state.status !== "error")
    return "not connected";
  return shortStatus(snapshot.state.message);
}
function limitedCountdown(snapshot) {
  const until = snapshot.limitedUntil;
  if (!until)
    return;
  const ms = until - Date.now();
  if (ms <= 0)
    return;
  return ms >= 90000 ? `${Math.round(ms / 60000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}
function windowsSummary(windows) {
  if (windows.length === 0)
    return "";
  const critical = windows.reduce((a, b) => remaining(a) <= remaining(b) ? a : b);
  const pct = `${Math.round(remaining(critical))}%`;
  const reset = formatReset(critical.resetsAt);
  return reset ? `${pct} ${reset}` : pct;
}
function summary(snapshot) {
  return windowsSummary(windowsOf(snapshot));
}
function UsageCommands(props) {
  props.ctx.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "usage.refresh",
      title: "Refresh usage",
      group: "Usage",
      palette: true,
      slash: {
        name: "usage"
      },
      suggested: true,
      run: async () => {
        await props.refresh({
          force: true
        });
        const lines = PROVIDER_IDS.filter((id) => props.enabled(id) && snapOf(props.state, id).state.status === "ok").flatMap((id) => {
          const snap = snapOf(props.state, id);
          const limited = limitedCountdown(snap);
          const suffix = limited ? ` (limited ${limited})` : "";
          const accounts = accountsOf(snap);
          if (snap.id === "claude" && accounts.length > 0) {
            return accounts.map((account) => account.windows.length > 0 ? `${snap.label} ${account.label} ${windowsSummary(account.windows)}` : `${snap.label} ${account.label}: ${shortStatus(account.message)}`);
          }
          return [`${snap.label} ${summary(snap)}${suffix}`];
        });
        props.ctx.ui.toast.show({
          title: "Usage",
          message: lines.length > 0 ? lines.join(`
`) : "No usage data available",
          variant: "info"
        });
      }
    }]
  }));
  return null;
}
function fiveHour(snapshot) {
  return windowsOf(snapshot).find((window) => window.label === "5h") ?? sortedWindows(windowsOf(snapshot))[0];
}
function StatusLine(props) {
  const theme = props.ctx.theme;
  const visible = () => PROVIDER_IDS.filter((id) => {
    const snap = snapOf(props.state, id);
    return props.enabled(id) && snap.state.status === "ok" && fiveHour(snap) !== undefined;
  });
  return _$createComponent(Show, {
    get when() {
      return visible().length > 0;
    },
    get children() {
      var _el$ = _$createElement("box");
      _$setProp(_el$, "flexDirection", "row");
      _$setProp(_el$, "gap", 0);
      _$insert(_el$, _$createComponent(For, {
        get each() {
          return visible();
        },
        children: (id, index) => {
          const snap = () => snapOf(props.state, id);
          const window = () => fiveHour(snap());
          return [_$createComponent(Show, {
            get when() {
              return index() > 0;
            },
            get children() {
              var _el$2 = _$createElement("text");
              _$insertNode(_el$2, _$createTextNode(` / `));
              _$setProp(_el$2, "wrapMode", "none");
              _$effect((_$p) => _$setProp(_el$2, "fg", theme.text.muted, _$p));
              return _el$2;
            }
          }), (() => {
            var _el$4 = _$createElement("text");
            _$setProp(_el$4, "wrapMode", "none");
            _$insert(_el$4, () => snap().label);
            _$effect((_$p) => _$setProp(_el$4, "fg", theme.text.base, _$p));
            return _el$4;
          })(), (() => {
            var _el$5 = _$createElement("text");
            _$setProp(_el$5, "wrapMode", "none");
            _$insert(_el$5, () => ` ${Math.round(remaining(window()))}%`);
            _$effect((_$p) => _$setProp(_el$5, "fg", theme.text.muted, _$p));
            return _el$5;
          })()];
        }
      }));
      return _el$;
    }
  });
}
function WindowRow(props) {
  const theme = props.ctx.theme;
  return (() => {
    var _el$6 = _$createElement("box"), _el$7 = _$createElement("text"), _el$8 = _$createElement("text"), _el$9 = _$createElement("text"), _el$0 = _$createElement("text");
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$6, _el$8);
    _$insertNode(_el$6, _el$9);
    _$insertNode(_el$6, _el$0);
    _$setProp(_el$6, "flexDirection", "row");
    _$setProp(_el$6, "gap", 0);
    _$setProp(_el$7, "wrapMode", "none");
    _$insert(_el$7, () => props.label);
    _$setProp(_el$8, "wrapMode", "none");
    _$insert(_el$8, () => ` ${props.window.label} `);
    _$setProp(_el$9, "wrapMode", "none");
    _$insert(_el$9, () => renderBar(remaining(props.window), 12));
    _$setProp(_el$0, "wrapMode", "none");
    _$insert(_el$0, () => ` ${Math.round(remaining(props.window))}% ${formatReset(props.window.resetsAt)}`);
    _$insert(_el$6, _$createComponent(Show, {
      get when() {
        return props.showLimited;
      },
      get children() {
        var _el$1 = _$createElement("text");
        _$setProp(_el$1, "wrapMode", "none");
        _$insert(_el$1, () => ` \u27F3 ${props.showLimited}`);
        _$effect((_$p) => _$setProp(_el$1, "fg", theme.text.muted, _$p));
        return _el$1;
      }
    }), null);
    _$effect((_p$) => {
      var _v$ = theme.text.base, _v$2 = theme.text.muted, _v$3 = feedbackColor(props.ctx, props.window), _v$4 = theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$7, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$8, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$9, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$0, "fg", _v$4, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$6;
  })();
}
function ProviderWindowRows(props) {
  return _$createComponent(For, {
    get each() {
      return sortedWindows(windowsOf(props.snapshot));
    },
    children: (window, index) => _$createComponent(WindowRow, {
      get ctx() {
        return props.ctx;
      },
      get label() {
        return _$memo(() => index() === 0)() ? props.snapshot.label.padEnd(LABEL_WIDTH) : " ".repeat(LABEL_WIDTH);
      },
      window,
      get showLimited() {
        return _$memo(() => index() === 0)() ? limitedCountdown(props.snapshot) : undefined;
      }
    })
  });
}
function ClaudeAccountRows(props) {
  const theme = props.ctx.theme;
  return _$createComponent(For, {
    get each() {
      return accountsOf(props.snapshot);
    },
    children: (account, accountIndex) => [_$createComponent(Show, {
      get when() {
        return accountIndex() > 0;
      },
      get children() {
        var _el$10 = _$createElement("text");
        _$insertNode(_el$10, _$createTextNode(` `));
        _$setProp(_el$10, "wrapMode", "none");
        return _el$10;
      }
    }), _$createComponent(Show, {
      get when() {
        return account.windows.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$13 = _$createElement("text");
          _$setProp(_el$13, "wrapMode", "none");
          _$insert(_el$13, () => `${" ".repeat(LABEL_WIDTH)} ${shortStatus(account.message)}`);
          _$effect((_$p) => _$setProp(_el$13, "fg", theme.text.muted, _$p));
          return _el$13;
        })();
      },
      get children() {
        return _$createComponent(For, {
          get each() {
            return sortedWindows(account.windows);
          },
          children: (window, index) => _$createComponent(WindowRow, {
            get ctx() {
              return props.ctx;
            },
            get label() {
              return _$memo(() => !!(accountIndex() === 0 && index() === 0))() ? props.snapshot.label.padEnd(LABEL_WIDTH) : " ".repeat(LABEL_WIDTH);
            },
            window,
            get showLimited() {
              return _$memo(() => !!(accountIndex() === 0 && index() === 0))() ? limitedCountdown(props.snapshot) : undefined;
            }
          })
        });
      }
    }), (() => {
      var _el$12 = _$createElement("text");
      _$setProp(_el$12, "wrapMode", "none");
      _$insert(_el$12, () => `${" ".repeat(LABEL_WIDTH + 4)}${account.label}`);
      _$effect((_$p) => _$setProp(_el$12, "fg", theme.text.muted, _$p));
      return _el$12;
    })()]
  });
}
function SidebarCard(props) {
  const ctx = props.ctx;
  const theme = ctx.theme;
  const visible = () => PROVIDER_IDS.filter((id) => props.enabled(id) && snapOf(props.state, id).state.status !== "missing");
  return (() => {
    var _el$14 = _$createElement("box");
    _$setProp(_el$14, "flexDirection", "column");
    _$insert(_el$14, _$createComponent(For, {
      get each() {
        return visible();
      },
      children: (id, index) => {
        const snap = () => snapOf(props.state, id);
        return [_$createComponent(Show, {
          get when() {
            return index() > 0;
          },
          get children() {
            var _el$15 = _$createElement("text");
            _$insertNode(_el$15, _$createTextNode(` `));
            _$setProp(_el$15, "wrapMode", "none");
            _$effect((_$p) => _$setProp(_el$15, "fg", theme.text.muted, _$p));
            return _el$15;
          }
        }), _$createComponent(Show, {
          get when() {
            return snap().state.status === "ok";
          },
          get fallback() {
            return (() => {
              var _el$17 = _$createElement("text");
              _$setProp(_el$17, "wrapMode", "none");
              _$insert(_el$17, () => `${snap().label.padEnd(LABEL_WIDTH)} ${missingText(snap())}`);
              _$effect((_$p) => _$setProp(_el$17, "fg", theme.text.muted, _$p));
              return _el$17;
            })();
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return accountsOf(snap()).length > 0;
              },
              get fallback() {
                return _$createComponent(ProviderWindowRows, {
                  ctx,
                  get snapshot() {
                    return snap();
                  }
                });
              },
              get children() {
                return _$createComponent(ClaudeAccountRows, {
                  ctx,
                  get snapshot() {
                    return snap();
                  }
                });
              }
            });
          }
        })];
      }
    }));
    return _el$14;
  })();
}
var tui_default = Plugin.define({
  id: "usage",
  setup(context) {
    const options = parseOptions(context.options);
    const refreshMs = options.refreshMs;
    const enabled = (id) => options.providers[id];
    const instanceId = Math.random().toString(36).slice(2, 8);
    setUsageLog(options.log);
    setClaudeUserAgent(options.claudeUserAgent);
    setCredentialLister(async () => (await context.client.credential.list()).map((entry) => ({
      id: entry.id,
      integrationID: entry.integrationID,
      label: entry.label,
      active: entry.active,
      value: entry.value
    })));
    writeUsageLog({
      event: "init",
      instance: instanceId,
      version: context.app.version
    });
    const [state, mutate] = context.storage.store("usage-state", {
      initial: initialState()
    });
    mutate((draft) => {
      for (const id of PROVIDER_IDS) {
        draft.providers[id] ??= initialSnapshot(id);
      }
    });
    let inFlight;
    let claudeRampMs = CLAUDE_BASE_INTERVAL_MS;
    const refresh = (opts) => {
      inFlight ??= runRefresh(opts).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    const runRefresh = async (opts) => {
      await Promise.all(PROVIDER_IDS.filter(enabled).map(async (id) => {
        const before = snapOf(state, id);
        const now0 = Date.now();
        if (before.limitedUntil && before.limitedUntil > now0) {
          writeUsageLog({
            event: "skip",
            instance: instanceId,
            provider: id,
            reason: "limited",
            limitedUntil: before.limitedUntil
          });
          return;
        }
        if (id === "claude" && !opts?.force && (before.cacheUntil ?? 0) > now0) {
          writeUsageLog({
            event: "skip",
            instance: instanceId,
            provider: id,
            reason: "cached",
            cacheUntil: before.cacheUntil
          });
          return;
        }
        const t0 = Date.now();
        const result = await PROVIDERS[id].query(options);
        const ms = Date.now() - t0;
        writeUsageLog({
          event: "refresh",
          instance: instanceId,
          provider: id,
          ms,
          outcome: result.ok ? result.limitedUntil ? "limited" : "ok" : result.kind,
          limitedUntil: result.ok ? result.limitedUntil : result.limitedUntil,
          cooldownIn: result.limitedUntil ? Math.round((result.limitedUntil - Date.now()) / 1000) + "s" : undefined,
          message: result.ok ? undefined : result.message.slice(0, 120)
        });
        mutate((draft) => {
          const previous = draft.providers[id] ?? initialSnapshot(id);
          const now = Date.now();
          if (previous.limitedUntil && previous.limitedUntil > now) {
            writeUsageLog({
              event: "skip",
              instance: instanceId,
              provider: id,
              limitedUntil: previous.limitedUntil
            });
            return;
          }
          if (!result.ok && result.kind === "error") {
            if (result.limitedUntil && previous.state.status === "ok") {
              draft.providers[id] = {
                ...previous,
                limitedUntil: result.limitedUntil
              };
              return;
            }
            if (previous.state.status === "ok" && now - previous.updatedAt < STALE_OK_MS) {
              return;
            }
          }
          let cacheUntil;
          if (result.ok && !result.limitedUntil) {
            if (result.cacheUntil !== undefined) {
              cacheUntil = result.cacheUntil;
            } else if (id === "claude") {
              cacheUntil = Date.now() + claudeRampMs;
              claudeRampMs = Math.min(CLAUDE_MAX_INTERVAL_MS, claudeRampMs * 2);
            }
          }
          draft.providers[id] = {
            id,
            label: PROVIDERS[id].label,
            updatedAt: now,
            limitedUntil: result.limitedUntil,
            cacheUntil,
            state: result.ok ? {
              status: "ok",
              plan: result.plan,
              windows: result.windows,
              accounts: result.accounts
            } : result.kind === "missing" ? {
              status: "missing",
              message: result.message
            } : {
              status: "error",
              message: result.message
            }
          };
        });
      }));
    };
    let lastExecutionRefresh = 0;
    const stopExecutionListener = context.data.on("session.execution.succeeded", () => {
      const now = Date.now();
      if (now - lastExecutionRefresh < 1e4)
        return;
      lastExecutionRefresh = now;
      claudeRampMs = CLAUDE_BASE_INTERVAL_MS;
      refresh();
    });
    const timer = setInterval(() => void refresh(), refreshMs);
    const initialTimer = setTimeout(() => void refresh({
      force: true
    }), Math.random() * 3000);
    const unregisterSlots = [];
    if (options.sidebar !== false) {
      unregisterSlots.push(context.ui.slot({
        append: "sidebar.content",
        render: () => _$createComponent(SidebarCard, {
          ctx: context,
          state,
          enabled
        })
      }));
    }
    if (options.footer !== false) {
      unregisterSlots.push(context.ui.slot({
        append: "prompt.footer.status",
        render: () => _$createComponent(StatusLine, {
          ctx: context,
          state,
          enabled
        })
      }));
    }
    if (options.home !== false) {
      unregisterSlots.push(context.ui.slot({
        append: "home.footer",
        render: () => (() => {
          var _el$18 = _$createElement("box");
          _$setProp(_el$18, "justifyContent", "center");
          _$insert(_el$18, _$createComponent(StatusLine, {
            ctx: context,
            state,
            enabled
          }));
          return _el$18;
        })()
      }));
    }
    unregisterSlots.push(context.ui.slot({
      append: "app",
      render: () => _$createComponent(UsageCommands, {
        ctx: context,
        refresh,
        enabled,
        state
      })
    }));
    return () => {
      clearInterval(timer);
      clearTimeout(initialTimer);
      stopExecutionListener();
      setCredentialLister(undefined);
      for (const unregister of unregisterSlots)
        unregister();
    };
  }
});
export {
  SidebarCard,
  StatusLine,
  tui_default as default
};
