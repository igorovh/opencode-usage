/**
 * Lightweight JSONL logger for the usage plugin.
 *
 * Writes to <dataDir>/log/usage-plugin.log so we can audit how often each
 * TUI instance calls the provider APIs. Logging must never break the plugin.
 */

import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let filePath: string | undefined;

function logPath(): string {
  if (!filePath) {
    const xdg = process.env["XDG_DATA_HOME"]?.trim();
    const dir = xdg ? join(xdg, "log") : join(homedir(), ".local", "share", "opencode", "log");
    filePath = join(dir, "usage-plugin.log");
  }
  return filePath;
}

export function writeUsageLog(line: Record<string, unknown>): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), ...line });
  void appendFile(logPath(), entry + "\n", "utf8").catch(() => {
    // ignore - logging must never break the plugin
  });
}
