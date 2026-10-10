import type { UsageWindow } from "./sources/types";

/** Filled/empty bar, e.g. "━━━━━━────". */
export function renderBar(usedPct: number, width = 10): string {
  const clamped = Math.min(100, Math.max(0, usedPct));
  const filled = Math.round((clamped / 100) * width);
  return "━".repeat(filled) + "─".repeat(width - filled);
}

/** "2h 14m" style countdown until the ISO timestamp; "" when unknown/past. */
export function formatReset(resetsAt: string | undefined, now = Date.now()): string {
  if (!resetsAt) return "";
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target) || target <= now) return "";
  return formatDuration(target - now);
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** The most-consumed window drives the color of a provider row. */
export function worstUsedPct(windows: readonly UsageWindow[]): number {
  return windows.reduce((worst, window) => Math.max(worst, window.usedPct), 0);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Short, human status for a provider/account error message. */
export function shortStatus(message: string | undefined): string {
  if (!message) return "not connected";
  if (/HTTP 429|rate limit/i.test(message)) {
    const wait = message.match(/retry in (\d+[ms])/i)?.[1];
    return wait ? `rate limited (${wait})` : "rate limited";
  }
  if (/HTTP 40[13]|unauthorized|expired/i.test(message)) return "login required";
  if (/no subscription|entitlement|HTTP 403/i.test(message)) return "no subscription";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/No .* token|connect|env/i.test(message)) return "not connected";
  return truncate(message, 24);
}
