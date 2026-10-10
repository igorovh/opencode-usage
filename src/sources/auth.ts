/**
 * Credential discovery for the providers.
 *
 * - OpenCode auth.json stores OAuth/API keys created via `/connect` (provider ids
 *   like "openai", "anthropic", "zai-coding-plan", ...).
 * - Claude accounts (multi-account) live in OpenCode's sqlite credential store.
 * - Codex CLI stores OAuth tokens in ~/.codex/auth.json.
 *
 * Only token *values* are returned; callers must not log them.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
  /** Account email parsed from the credential label, when present. */
  email?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; the auth plugin rotates tokens behind this store. */
  expires?: number;
  /** OpenCode marks this account as the one used for new sessions. */
  active: boolean;
}

let claudeAccountsCache: { at: number; value: OpencodeClaudeAccount[] } | undefined;

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

/**
 * Claude accounts (integration id "anthropic") stored by OpenCode's /connect
 * and kept fresh by the OAuth auth plugin. Read-only: token rotation stays
 * with the auth plugin, this only snapshots what is on disk.
 */
export async function readOpencodeClaudeAccounts(force = false): Promise<OpencodeClaudeAccount[]> {
  const now = Date.now();
  if (!force && claudeAccountsCache && now - claudeAccountsCache.at < CACHE_TTL_MS) {
    return claudeAccountsCache.value;
  }
  const accounts: OpencodeClaudeAccount[] = [];
  try {
    const { Database } = await import("bun:sqlite");
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
        const rows = db
          .query("select id, label, value, active from credential where integration_id = ?")
          .all("anthropic") as Array<{
          id: string;
          label: string | null;
          value: string;
          active: number | null;
        }>;
        for (const row of rows) {
          try {
            const parsed = asRecord(JSON.parse(row.value));
            const access = firstString(parsed, ["access", "accessToken"]);
            if (!access) continue;
            accounts.push({
              id: row.id,
              email: emailFromLabel(row.label),
              accessToken: access,
              refreshToken: firstString(parsed, ["refresh", "refreshToken"]),
              expires: typeof parsed?.expires === "number" ? parsed.expires : undefined,
              active: row.active === 1,
            });
          } catch {
            // skip malformed credential row
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // bun:sqlite unavailable - treat as no accounts
  }
  const seen = new Set<string>();
  const unique = accounts.filter((account) =>
    seen.has(account.id) ? false : (seen.add(account.id), true),
  );
  unique.sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));
  claudeAccountsCache = { at: now, value: unique };
  return unique;
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
