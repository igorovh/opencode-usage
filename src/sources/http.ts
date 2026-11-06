/** fetch with timeout + JSON decoding. Tokens are never included in errors. */

export class HttpError extends Error {
  readonly status: number;
  /** Server-provided wait time (Retry-After), when present. */
  readonly retryAfterMs?: number;
  constructor(status: number, url: string, retryAfterMs?: number) {
    // Never embed response bodies: they can echo credentials in some APIs.
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

export async function fetchJson<T>(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...options.headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HttpError(response.status, url, parseRetryAfter(response.headers.get("retry-after")));
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out: ${url}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Cooldown when a 429 carries no Retry-After. */
const DEFAULT_RATE_LIMIT_MS = 5 * 60_000;
const MAX_RATE_LIMIT_MS = 30 * 60_000;

export function describe(error: unknown, provider: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401/.test(message)) return `${provider}: unauthorized - token expired, re-authenticate.`;
  if (/HTTP 403/.test(message)) return `${provider}: forbidden - no subscription or access (HTTP 403).`;
  return `${provider}: ${message}`;
}

/** Epoch ms until the next call is allowed after a 429; undefined for other errors. */
export function rateLimitedUntil(error: unknown, now = Date.now()): number | undefined {
  if (!(error instanceof HttpError) || error.status !== 429) return undefined;
  const wait = error.retryAfterMs && error.retryAfterMs > 0 ? error.retryAfterMs : DEFAULT_RATE_LIMIT_MS;
  return now + Math.min(MAX_RATE_LIMIT_MS, wait);
}

export function formatWait(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

export function clampPct(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(100, Math.max(0, n));
}

/** epoch seconds or epoch ms -> ISO string */
export function toIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(Math.round(ms));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function isoFromNowPlusSeconds(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
}
