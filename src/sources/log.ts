/**
 * Opt-in JSONL call log (`log: true`) at <dataDir>/log/usage-plugin.log, for auditing
 * how often each TUI instance calls the provider APIs. Logging must never break the plugin.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { opencodeDataDir } from "./auth";

/** The log is rotated to `.1` once it reaches this size. */
const MAX_LOG_BYTES = 1024 * 1024;

let enabled = false;
let writes: Promise<void> = Promise.resolve();

export function setUsageLog(on: boolean): void {
  enabled = on;
}

export function usageLogPath(): string {
  return join(opencodeDataDir(), "log", "usage-plugin.log");
}

async function append(entry: string): Promise<void> {
  const path = usageLogPath();
  await mkdir(dirname(path), { recursive: true });
  const size = await stat(path).then((info) => info.size, () => 0);
  if (size >= MAX_LOG_BYTES) await rename(path, `${path}.1`);
  await appendFile(path, entry, "utf8");
}

export function writeUsageLog(line: Record<string, unknown>): void {
  if (!enabled) return;
  const entry = JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n";
  // Serialized so rotation never races with an append from the same instance.
  writes = writes.then(() => append(entry)).catch(() => {});
}
