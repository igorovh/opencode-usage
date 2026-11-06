/**
 * Credential discovery for the providers.
 *
 * - OpenCode V2 keeps `/connect` credentials in its store. The TUI reads them through
 *   `client.credential.list()`; standalone scripts fall back to reading opencode.db.
 * - The V1 auth.json is still read as a last resort for older installs.
 * - The Claude Agent integration only marks itself in the store and uses Claude Code's login.
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

/** `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode` - the same on every OS. */
export function opencodeDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"]?.trim();
  return join(xdg || join(homedir(), ".local", "share"), "opencode");
}

// ---------------------------------------------------------------------------
// OpenCode credential store
// ---------------------------------------------------------------------------

/** One stored credential, normalized from the client API or the sqlite store. */
export interface StoredCredential {
  id: string;
  integrationID: string;
  label: string;
  active: boolean;
  value: Json;
}

type CredentialLister = () => Promise<readonly StoredCredential[]>;

let credentialLister: CredentialLister | undefined;
let credentialCache: { at: number; value: readonly StoredCredential[] } | undefined;

/** The TUI plugin registers the host client here; without it the sqlite store is read. */
export function setCredentialLister(lister: CredentialLister | undefined): void {
  credentialLister = lister;
  credentialCache = undefined;
}

function opencodeDbPath(): string {
  return process.env["OPENCODE_DB"]?.trim() || join(opencodeDataDir(), "opencode.db");
}

interface CredentialRow {
  id: string;
  integration_id: string;
  label: string | null;
  value: string;
  active: number | null;
}

async function readCredentialRows(): Promise<StoredCredential[]> {
  const path = opencodeDbPath();
  if (!existsSync(path)) return [];
  try {
    const { Database } = await import("bun:sqlite");
    // Read-only + WAL lets this run alongside the TUI that owns the store.
    const db = new Database(path, { readonly: true });
    try {
      const rows = db
        .query("select id, integration_id, label, value, active from credential")
        .all() as CredentialRow[];
      return rows.flatMap((row) => {
        try {
          const value = asRecord(JSON.parse(row.value));
          if (!value) return [];
          return [{
            id: row.id,
            integrationID: row.integration_id,
            label: row.label ?? "",
            active: row.active === 1,
            value,
          }];
        } catch {
          return [];
        }
      });
    } finally {
      db.close();
    }
  } catch {
    // no bun:sqlite, or a store without a credential table
    return [];
  }
}

export async function listCredentials(force = false): Promise<readonly StoredCredential[]> {
  const now = Date.now();
  if (!force && credentialCache && now - credentialCache.at < CACHE_TTL_MS) return credentialCache.value;
  let value: readonly StoredCredential[] | undefined;
  if (credentialLister) {
    try {
      value = await credentialLister();
    } catch {
      // server unreachable - fall back to the store on disk
    }
  }
  value ??= await readCredentialRows();
  credentialCache = { at: now, value };
  return value;
}

/** Credentials for the first integration id that has any, active ones first. */
export async function credentialsFor(integrationIds: readonly string[]): Promise<StoredCredential[]> {
  const all = await listCredentials();
  for (const id of integrationIds) {
    const matches = all.filter((credential) => credential.integrationID === id);
    if (matches.length > 0) return matches.sort((a, b) => Number(b.active) - Number(a.active));
  }
  return [];
}

export function credentialKey(credential: StoredCredential): string | undefined {
  return credential.value["type"] === "key" ? firstString(credential.value, ["key"]) : undefined;
}

export function credentialOAuth(
  credential: StoredCredential,
): { access: string; refresh?: string; expires?: number; metadata?: Json } | undefined {
  if (credential.value["type"] !== "oauth") return undefined;
  const access = firstString(credential.value, ["access"]);
  if (!access) return undefined;
  const expires = credential.value["expires"];
  return {
    access,
    refresh: firstString(credential.value, ["refresh"]),
    expires: typeof expires === "number" ? expires : undefined,
    metadata: asRecord(credential.value["metadata"]),
  };
}

// ---------------------------------------------------------------------------
// Legacy V1 auth.json
// ---------------------------------------------------------------------------

let legacyAuthCache: { at: number; value: Json | null } | undefined;

async function readLegacyAuth(): Promise<Json | null> {
  const now = Date.now();
  if (legacyAuthCache && now - legacyAuthCache.at < CACHE_TTL_MS) return legacyAuthCache.value;
  let value: Json | null = null;
  try {
    value = asRecord(JSON.parse(await readFile(join(opencodeDataDir(), "auth.json"), "utf8"))) ?? null;
  } catch {
    // no V1 auth.json
  }
  legacyAuthCache = { at: now, value };
  return value;
}

export interface LegacyAuthEntry {
  type?: string;
  key?: string;
  access?: string;
  expires?: number;
  accountId?: string;
}

/** Returns the V1 auth.json entry for the first matching provider id. */
export async function legacyAuthEntry(
  providerIds: readonly string[],
): Promise<{ id: string; entry: LegacyAuthEntry } | undefined> {
  const auth = await readLegacyAuth();
  if (!auth) return undefined;
  for (const id of providerIds) {
    const entry = asRecord(auth[id]);
    if (entry) return { id, entry: entry as LegacyAuthEntry };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Claude accounts
// ---------------------------------------------------------------------------

/** One Claude account from the OpenCode credential store. */
export interface OpencodeClaudeAccount {
  /** Credential id - stable key for per-account caches. */
  id: string;
  /** "claude-agent" tokens come from the Claude Code login the Agent SDK uses. */
  source: "anthropic" | "claude-agent";
  /** Account email parsed from the credential label, when present. */
  email?: string;
  accessToken: string;
  /** Epoch ms; whoever owns the login rotates tokens behind this store. */
  expires?: number;
  /** OpenCode marks this account as the one used for new sessions. */
  active: boolean;
}

export interface OpencodeClaudeAccounts {
  /** Claude Agent is connected: "anthropic" OAuth accounts are hidden. */
  agent: boolean;
  accounts: OpencodeClaudeAccount[];
}

let claudeAccountsCache: { at: number; value: OpencodeClaudeAccounts } | undefined;

function emailFromLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  return label.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
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

async function readClaudeAgentAccount(credential: StoredCredential): Promise<OpencodeClaudeAccount | undefined> {
  const oauth = await readClaudeCodeLogin();
  const access = firstString(oauth, ["accessToken"]);
  if (!access) return undefined;
  return {
    id: credential.id,
    source: "claude-agent",
    email: (await readClaudeCodeEmail()) ?? emailFromLabel(credential.label),
    accessToken: access,
    expires: typeof oauth?.["expiresAt"] === "number" ? oauth["expiresAt"] : undefined,
    active: true,
  };
}

function anthropicAccount(credential: StoredCredential): OpencodeClaudeAccount | undefined {
  const oauth = credentialOAuth(credential);
  if (!oauth) return undefined;
  return {
    id: credential.id,
    source: "anthropic",
    email: emailFromLabel(credential.label),
    accessToken: oauth.access,
    expires: oauth.expires,
    active: credential.active,
  };
}

/**
 * Claude accounts connected in OpenCode. A connected Claude Agent wins and
 * hides the "anthropic" OAuth accounts. Read-only: token rotation stays with
 * whoever owns the login, this only snapshots what is stored.
 */
export async function readOpencodeClaudeAccounts(force = false): Promise<OpencodeClaudeAccounts> {
  const now = Date.now();
  if (!force && claudeAccountsCache && now - claudeAccountsCache.at < CACHE_TTL_MS) {
    return claudeAccountsCache.value;
  }
  const all = await listCredentials(force);
  const agent = all.find((credential) => credential.integrationID === "claude-agent");
  let value: OpencodeClaudeAccounts;
  if (agent) {
    const account = await readClaudeAgentAccount(agent);
    value = { agent: true, accounts: account ? [account] : [] };
  } else {
    const accounts = all
      .filter((credential) => credential.integrationID === "anthropic")
      .map(anthropicAccount)
      .filter((account): account is OpencodeClaudeAccount => !!account);
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
    const tokens = asRecord(asRecord(JSON.parse(content))?.["tokens"]);
    const accessToken = firstString(tokens, ["access_token"]);
    if (!accessToken) return undefined;
    return { accessToken, accountId: firstString(tokens, ["account_id"]) };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// JWT helpers (OpenAI access tokens carry the ChatGPT account id)
// ---------------------------------------------------------------------------

interface OpenAiJwtPayload {
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
    return asRecord(JSON.parse(base64UrlDecode(parts[1]!))) as OpenAiJwtPayload | undefined;
  } catch {
    return undefined;
  }
}

export function stringField(value: unknown, key: string): string | undefined {
  return firstString(value, [key]);
}
