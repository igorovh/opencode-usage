import type { ProviderId } from "./sources/types";

export const PROVIDER_IDS = ["codex", "claude", "glm", "opencode-go"] as const satisfies readonly ProviderId[];

export const DEFAULT_REFRESH_MS = 60_000;
export const MIN_REFRESH_MS = 15_000;

export interface UsageOptions {
  refreshMs: number;
  sidebar: boolean;
  footer: boolean;
  home: boolean;
  providers: Record<ProviderId, boolean>;
  goApiKey?: string;
  goBaseUrl?: string;
  claudeUserAgent?: string;
  log: boolean;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Validates raw plugin options; anything malformed falls back to its default. */
export function parseOptions(raw: unknown): UsageOptions {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const refresh = input["refreshMs"];
  const providers = input["providers"] && typeof input["providers"] === "object"
    ? (input["providers"] as Record<string, unknown>)
    : {};
  return {
    refreshMs:
      typeof refresh === "number" && Number.isFinite(refresh)
        ? Math.max(MIN_REFRESH_MS, refresh)
        : DEFAULT_REFRESH_MS,
    sidebar: bool(input["sidebar"], true),
    footer: bool(input["footer"], true),
    home: bool(input["home"], true),
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, bool(providers[id], true)])) as Record<
      ProviderId,
      boolean
    >,
    // `apiKey` is the option name of the standalone OpenCode Go usage plugin.
    goApiKey: text(input["goApiKey"]) ?? text(input["apiKey"]),
    goBaseUrl: text(input["goBaseUrl"]),
    claudeUserAgent: text(input["claudeUserAgent"]),
    log: bool(input["log"], false),
  };
}
