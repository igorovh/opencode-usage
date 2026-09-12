/**
 * Credential discovery for the three providers.
 *
 * - OpenCode auth.json stores OAuth/API keys created via `/connect` (provider ids
 *   like "openai", "anthropic", "zai-coding-plan", ...).
 * - Claude Code stores its own OAuth token in ~/.claude/.credentials.json.
 * - Codex CLI stores OAuth tokens in ~/.codex/auth.json.
 *
 * Only token *values* are returned; callers must not log them.
 */

import { readFile } from "node:fs/promises";
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
// Claude Code credentials
// ---------------------------------------------------------------------------

export async function claudeOAuthToken(): Promise<string | undefined> {
  const envToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"]?.trim();
  if (envToken) return envToken;

  const configDir = process.env["CLAUDE_CONFIG_DIR"]?.trim() || join(homedir(), ".claude");
  try {
    const content = await readFile(join(configDir, ".credentials.json"), "utf8");
    const parsed = asRecord(JSON.parse(content));
    const oauth = asRecord(parsed?.["claudeAiOauth"]) ?? asRecord(parsed?.["oauth"]) ?? parsed;
    return firstString(oauth, ["accessToken", "access_token", "token"]);
  } catch {
    return undefined;
  }
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
