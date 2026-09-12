/** Shared types for usage sources. All run inside the TUI (Bun) process. */

export type ProviderId = "codex" | "claude" | "glm";

/** One measured quota window (e.g. the rolling 5-hour window or the weekly cap). */
export interface UsageWindow {
  /** Short label, e.g. "5h", "7d", "30d". */
  label: string;
  /** Utilization, 0..100. */
  usedPct: number;
  /** ISO timestamp when the window resets, when known. */
  resetsAt?: string;
}

export type ProviderState =
  | { readonly status: "ok"; readonly plan?: string; readonly windows: readonly UsageWindow[] }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "missing"; readonly message?: string };

export interface ProviderSnapshot {
  readonly id: ProviderId;
  readonly label: string;
  readonly state: ProviderState;
  /** Epoch ms of the last successful or attempted refresh. */
  readonly updatedAt: number;
  /** Data is cached because the API is rate-limiting us (epoch ms until retry). */
  readonly limitedUntil?: number;
  /** Data is cached due to healthy polling throttle (epoch ms). */
  readonly cacheUntil?: number;
}

export type QuotaResult =
  | {
      ok: true;
      plan?: string;
      windows: UsageWindow[];
      /** Data served from cache because the API is rate-limiting us (epoch ms until retry). */
      limitedUntil?: number;
      /** Data served from cache due to the healthy polling throttle (epoch ms). */
      cacheUntil?: number;
    }
  | {
      ok: false;
      kind: "missing" | "error";
      message: string;
      /** For rate-limit errors: epoch ms until the next attempt is allowed. */
      limitedUntil?: number;
    };

export function errorResult(message: string): QuotaResult {
  return { ok: false, kind: "error", message };
}

export function missingResult(message: string): QuotaResult {
  return { ok: false, kind: "missing", message };
}
