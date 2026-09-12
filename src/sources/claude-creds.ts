/**
 * Claude Code OAuth credentials: load, refresh, persist.
 *
 * Mirrors the CodexBar approach: when the stored access token expires, trade
 * the stored refresh token at platform.claude.com/v1/oauth/token (using the
 * official Claude Code client id) and write the rotated tokens back to
 * ~/.claude/.credentials.json so the Claude CLI keeps working with them.
 *
 * Never logs token values.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_FAILURE_BACKOFF_MS = 5 * 60_000;

export interface ClaudeCreds {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Path the credentials were loaded from (only file-backed creds rotate). */
  filePath?: string;
}

interface ClaudeAiOauth {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  [key: string]: unknown;
}

function credsPath(): string {
  const configDir = process.env["CLAUDE_CONFIG_DIR"]?.trim() || join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reads the Claude Code credentials file (used for load AND rotate-and-persist). */
export async function readClaudeCredsFile(): Promise<ClaudeCreds | undefined> {
  try {
    const content = await readFile(credsPath(), "utf8");
    const parsed = JSON.parse(content) as { claudeAiOauth?: ClaudeAiOauth };
    const oauth = parsed.claudeAiOauth;
    const accessToken = str(oauth?.accessToken);
    if (!accessToken) return undefined;
    return {
      accessToken,
      refreshToken: str(oauth?.refreshToken),
      expiresAt: typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined,
      filePath: credsPath(),
    };
  } catch {
    return undefined;
  }
}

/** POST refresh_token -> new tokens (CodexBar-compatible endpoint and client id). */
async function refreshRequest(
  refreshToken: string,
  timeoutMs = 15_000,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
    const response = await fetch(REFRESH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      // invalid_grant means the refresh token is dead - terminal until re-login.
      const terminal = response.status === 400 || response.status === 401;
      throw new RefreshError(
        `HTTP ${response.status}`,
        terminal ? "terminal" : "transient",
      );
    }
    const parsed = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const accessToken = str(parsed.access_token);
    if (!accessToken) throw new RefreshError("missing access_token", "transient");
    return {
      accessToken,
      refreshToken: str(parsed.refresh_token) ?? refreshToken,
      expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : undefined,
    };
  } catch (error) {
    if (error instanceof RefreshError) throw error;
    throw new RefreshError(error instanceof Error ? error.message : String(error), "transient");
  } finally {
    clearTimeout(timer);
  }
}

export class RefreshError extends Error {
  readonly kind: "terminal" | "transient";
  constructor(message: string, kind: "terminal" | "transient") {
    super(message);
    this.kind = kind;
  }
}

/** Writes rotated tokens back so the Claude CLI keeps working with them. */
async function persistClaudeCreds(
  filePath: string,
  update: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<void> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as { claudeAiOauth?: ClaudeAiOauth };
  if (!parsed.claudeAiOauth) return;
  parsed.claudeAiOauth["accessToken"] = update.accessToken;
  parsed.claudeAiOauth["refreshToken"] = update.refreshToken;
  parsed.claudeAiOauth["expiresAt"] = update.expiresAt;
  const content = JSON.stringify(parsed, null, 2);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, filePath);
  } catch {
    await writeFile(filePath, content, "utf8"); // rename can be picky on Windows
    await writeFile(tmp, "").catch(() => {}); // best-effort cleanup
  }
}

export interface RefreshOutcome {
  creds: ClaudeCreds;
  /** Cooldown before the next refresh attempt after a transient failure. */
  retryAfterMs?: number;
  terminal?: boolean;
}

/**
 * Refreshes the Claude Code OAuth token when needed and persists the rotation.
 * Returns undefined when there is no refresh token or refresh is not possible.
 */
export async function refreshClaudeCreds(
  creds: ClaudeCreds,
  now = Date.now(),
): Promise<RefreshOutcome | undefined> {
  if (!creds.refreshToken || !creds.filePath) return undefined;
  try {
    const refreshed = await refreshRequest(creds.refreshToken);
    const expiresAt = now + (refreshed.expiresIn ?? 12 * 3600) * 1000;
    await persistClaudeCreds(creds.filePath, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? creds.refreshToken,
      expiresAt,
    });
    return {
      creds: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? creds.refreshToken,
        expiresAt,
        filePath: creds.filePath,
      },
    };
  } catch (error) {
    const refreshError = error instanceof RefreshError ? error : undefined;
    return {
      creds,
      retryAfterMs: refreshError?.kind === "terminal" ? Number.POSITIVE_INFINITY : REFRESH_FAILURE_BACKOFF_MS,
      terminal: refreshError?.kind === "terminal",
    };
  }
}
