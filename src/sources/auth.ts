/**
 * Credential discovery for the providers.
 *
 * - OpenCode auth.json stores OAuth/API keys created via `/connect` (provider ids
 *   like "openai", "anthropic", "zai-coding-plan", ...).
 * - Claude accounts (multi-account) live in OpenCode's sqlite credential store;
 *   the Claude Agent integration only marks itself there and uses Claude Code's login.
 * - Codex CLI stores OAuth tokens in ~/.codex/auth.json.
 *
 * Only token *values* are returned; callers must not log them.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const CACHE_TTL_MS = 5_000;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function firstString(value: unknown, keys: string[]): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenCode auth.json
// ---------------------------------------------------------------------------

let opencodeAuthCache: { at: number; value: Json | null } | undefined;

function opencodeDataDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];
  const xdgData = process.env["XDG_DATA_HOME"]?.trim();
  if (xdgData) dirs.push(xdgData);
  dirs.push(join(home, ".local", "share", "opencode"));
  if (process.platform === "darwin") {
    dirs.push(join(home, "Library", "Application Support", "opencode"));
  }
  if (process.platform === "win32" && process.env["LOCALAPPDATA"]) {
    dirs.push(join(process.env["LOCALAPPDATA"], "opencode"));
  }
  return dirs;
}

export async function readOpencodeAuth(): Promise<Json | null> {
  const now = Date.now();
  if (opencodeAuthCache && now - opencodeAuthCache.at < CACHE_TTL_MS) {
    return opencodeAuthCache.value;
  }
  // Explicit file override (used by opencode itself).
  const explicit = process.env["OPENCODE_AUTH_JSON"]?.trim();
  if (explicit) {
    try {
      const content = await readFile(explicit, "utf8");
      const parsed = asRecord(JSON.parse(content));
      if (parsed) {
        opencodeAuthCache = { at: now, value: parsed };
        return parsed;
      }
    } catch {
      // fall through to the standard locations
    }
  }
  let value: Json | null = null;
  for (const dir of opencodeDataDirs()) {
    try {
      const content = await readFile(join(dir, "auth.json"), "utf8");
      const parsed = asRecord(JSON.parse(content));
      if (parsed) {
        value = parsed;
        break;
      }
    } catch {
      // try next candidate
    }
  }
  opencodeAuthCache = { at: now, value };
  return value;
}

export interface OpencodeAuthEntry {
  type?: string;
  key?: string;
  apiKey?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

/** Returns the auth.json entry for a provider id, e.g. "zai-coding-plan". */
export async function opencodeAuthEntry(
  providerIds: readonly string[],
): Promise<{ id: string; entry: OpencodeAuthEntry } | undefined> {
  const auth = await readOpencodeAuth();
  if (!auth) return undefined;
  for (const id of providerIds) {
    const entry = asRecord(auth[id]);
    if (entry) return { id, entry: entry as OpencodeAuthEntry };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenCode credential store (sqlite)
// ---------------------------------------------------------------------------

/** One Claude account from the OpenCode credential store. */
export interface OpencodeClaudeAccount {
  /** Credential row id - stable key for per-account caches. */
  id: string;
  /** "claude-agent" tokens come from the Claude Code login the Agent SDK uses. */
  source: "anthropic" | "claude-agent";
  /** Account email parsed from the credential label, when present. */
  email?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; the auth plugin rotates tokens behind this store. */
  expires?: number;
  /** OpenCode marks this account as the one used for new sessions. */
  active: boolean;
}

export interface OpencodeClaudeAccounts {
  /** Claude Agent is connected: legacy "anthropic" accounts are hidden. */
  agent: boolean;
  accounts: OpencodeClaudeAccount[];
}

let claudeAccountsCache: { at: number; value: OpencodeClaudeAccounts } | undefined;

function opencodeDbPaths(): string[] {
  const paths: string[] = [];
  for (const dir of opencodeDataDirs()) {
    paths.push(join(dir, "opencode.db"), join(dir, "opencode-next.db"));
  }
  return [...new Set(paths)];
}

function emailFromLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  return label.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
}

interface CredentialRow {
  id: string;
  integration_id: string;
  label: string | null;
  value: string;
  active: number | null;
}

async function readCredentialRows(integrationIds: readonly string[]): Promise<CredentialRow[]> {
  const rows: CredentialRow[] = [];
  try {
    const { Database } = await import("bun:sqlite");
    const placeholders = integrationIds.map(() => "?").join(", ");
    for (const path of opencodeDbPaths()) {
      if (!existsSync(path)) continue;
      // Read-only + WAL lets this run alongside the TUI that owns the store.
      let db: { query(sql: string): { all(...params: unknown[]): unknown[] } ; close(): void };
      try {
        db = new Database(path, { readonly: true });
      } catch {
        continue;
      }
      try {
        rows.push(
          ...(db
            .query(
              `select id, integration_id, label, value, active from credential where integration_id in (${placeholders})`,
            )
            .all(...integrationIds) as CredentialRow[]),
        );
      } catch {
        // store without a credential table
      } finally {
        db.close();
      }
    }
  } catch {
    // bun:sqlite unavailable - treat as no accounts
  }
  return rows;
}

function claudeConfigDir(): string | undefined {
  return process.env["CLAUDE_CONFIG_DIR"]?.trim() || undefined;
}

/** Keychain service Claude Code uses on macOS; a custom config dir gets a hash suffix. */
function claudeKeychainService(): string {
  const dir = claudeConfigDir();
  if (!dir) return "Claude Code-credentials";
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function readKeychainSecret(service: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-a", userInfo().username, "-s", service, "-w"],
      { timeout: 5_000 },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
    );
  });
}

/** Claude Code's OAuth login, which the Claude Agent SDK reuses and refreshes. */
async function readClaudeCodeLogin(): Promise<Json | undefined> {
  const candidates: Array<() => Promise<string | undefined>> = [];
  if (process.platform === "darwin") candidates.push(() => readKeychainSecret(claudeKeychainService()));
  const file = join(claudeConfigDir() ?? join(homedir(), ".claude"), ".credentials.json");
  candidates.push(() => readFile(file, "utf8").catch(() => undefined));
  for (const read of candidates) {
    const content = await read();
    if (!content) continue;
    try {
      const oauth = asRecord(asRecord(JSON.parse(content))?.["claudeAiOauth"]);
      if (firstString(oauth, ["accessToken"])) return oauth;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

async function readClaudeCodeEmail(): Promise<string | undefined> {
  const file = join(claudeConfigDir() ?? homedir(), ".claude.json");
  try {
    const parsed = asRecord(JSON.parse(await readFile(file, "utf8")));
    return firstString(asRecord(parsed?.["oauthAccount"]), ["emailAddress"]);
  } catch {
    return undefined;
  }
}

async function readClaudeAgentAccount(row: CredentialRow): Promise<OpencodeClaudeAccount | undefined> {
  const oauth = await readClaudeCodeLogin();
  const access = firstString(oauth, ["accessToken"]);
  if (!access) return undefined;
  return {
    id: row.id,
    source: "claude-agent",
    email: (await readClaudeCodeEmail()) ?? emailFromLabel(row.label),
    accessToken: access,
    refreshToken: firstString(oauth, ["refreshToken"]),
    expires: typeof oauth?.["expiresAt"] === "number" ? oauth["expiresAt"] : undefined,
    active: true,
  };
}

function anthropicAccount(row: CredentialRow): OpencodeClaudeAccount | undefined {
  try {
    const parsed = asRecord(JSON.parse(row.value));
    const access = firstString(parsed, ["access", "accessToken"]);
    if (!access) return undefined;
    return {
      id: row.id,
      source: "anthropic",
      email: emailFromLabel(row.label),
      accessToken: access,
      refreshToken: firstString(parsed, ["refresh", "refreshToken"]),
      expires: typeof parsed?.expires === "number" ? parsed.expires : undefined,
      active: row.active === 1,
    };
  } catch {
    return undefined;
  }
}

/**
 * Claude accounts connected in OpenCode. A connected Claude Agent wins and
 * hides the legacy "anthropic" OAuth accounts. Read-only: token rotation stays
 * with the auth plugin / Claude Code, this only snapshots what is stored.
 */
export async function readOpencodeClaudeAccounts(force = false): Promise<OpencodeClaudeAccounts> {
  const now = Date.now();
  if (!force && claudeAccountsCache && now - claudeAccountsCache.at < CACHE_TTL_MS) {
    return claudeAccountsCache.value;
  }
  const rows = await readCredentialRows(["anthropic", "claude-agent"]);
  const agentRow = rows.find((row) => row.integration_id === "claude-agent");
  let value: OpencodeClaudeAccounts;
  if (agentRow) {
    const account = await readClaudeAgentAccount(agentRow);
    value = { agent: true, accounts: account ? [account] : [] };
  } else {
    const seen = new Set<string>();
    const accounts = rows
      .map(anthropicAccount)
      .filter((account): account is OpencodeClaudeAccount => !!account)
      .filter((account) => (seen.has(account.id) ? false : (seen.add(account.id), true)));
    accounts.sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));
    value = { agent: false, accounts };
  }
  claudeAccountsCache = { at: now, value };
  return value;
}

// ---------------------------------------------------------------------------
// Codex CLI credentials
// ---------------------------------------------------------------------------

export interface CodexTokens {
  accessToken: string;
  accountId?: string;
}

export async function codexCliTokens(): Promise<CodexTokens | undefined> {
  const codexHome = process.env["CODEX_HOME"]?.trim() || join(homedir(), ".codex");
  try {
    const content = await readFile(join(codexHome, "auth.json"), "utf8");
    const parsed = asRecord(JSON.parse(content));
    const tokens = asRecord(parsed?.["tokens"]);
    const accessToken = firstString(tokens, ["access_token"]);
    if (!accessToken) return undefined;
    return {
      accessToken,
      accountId: firstString(tokens, ["account_id"]),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// JWT helpers (OpenAI access tokens carry the ChatGPT account id)
// ---------------------------------------------------------------------------

interface OpenAiJwtPayload {
  "https://api.openai.com/profile"?: { email?: string };
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

export function parseOpenAiJwt(token: string): OpenAiJwtPayload | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    return asRecord(JSON.parse(base64UrlDecode(parts[1])!)) as OpenAiJwtPayload | undefined;
  } catch {
    return undefined;
  }
}
