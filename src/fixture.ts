import { readFile } from "node:fs/promises";
import type { ClaudeAccountUsage, ProviderId, QuotaResult, UsageWindow } from "./sources/types";

/** Fixture window: like UsageWindow, with the reset given relative to now. */
interface FixtureWindow {
  label: string;
  usedPct: number;
  resetsInMin?: number;
}

interface FixtureProvider {
  plan?: string;
  windows: FixtureWindow[];
  accounts?: { label: string; active?: boolean; windows: FixtureWindow[] }[];
}

/** Path to a JSON file with made-up usage (see docs/demo-fixture.json); no API is called when set. */
export function fixturePath(): string | undefined {
  return process.env["OPENCODE_USAGE_FIXTURE"]?.trim() || undefined;
}

function toWindows(windows: readonly FixtureWindow[], now: number): UsageWindow[] {
  return windows.map((window) => ({
    label: window.label,
    usedPct: window.usedPct,
    resetsAt: window.resetsInMin === undefined ? undefined : new Date(now + window.resetsInMin * 60_000).toISOString(),
  }));
}

export async function queryFixture(path: string, id: ProviderId): Promise<QuotaResult> {
  const fixture = JSON.parse(await readFile(path, "utf8")) as Partial<Record<ProviderId, FixtureProvider>>;
  const provider = fixture[id];
  if (!provider) return { ok: false, kind: "missing", message: "Not in the fixture." };
  const now = Date.now();
  const accounts = provider.accounts?.map(
    (account): ClaudeAccountUsage => ({
      label: account.label,
      active: account.active ?? false,
      windows: toWindows(account.windows, now),
    }),
  );
  return { ok: true, plan: provider.plan, windows: toWindows(provider.windows, now), accounts };
}
