/**
 * opencode-usage - OpenCode V2 TUI plugin.
 *
 * Shows Codex / Claude / GLM Coding Plan / OpenCode Go usage:
 * - a card in the session sidebar (slot "sidebar.content")
 * - a compact one-liner in the prompt footer status (slot "prompt.footer.status")
 * - a one-liner on the home screen (slot "home.footer")
 *
 * Data is refreshed on an interval (default 60s), when a session execution
 * finishes, and on demand via the /usage slash command.
 */

/** @jsxImportSource @opentui/solid */

import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { For, Show } from "solid-js";
import { formatReset, renderBar, shortStatus } from "./format";
import { fixturePath, queryFixture } from "./fixture";
import { PROVIDER_IDS, parseOptions, type UsageOptions } from "./options";
import { setCredentialLister, type StoredCredential } from "./sources/auth";
import { writeUsageLog, setUsageLog } from "./sources/log";
import { queryClaude, setClaudeUserAgent } from "./sources/claude";
import { queryCodex } from "./sources/codex";
import { queryGlm } from "./sources/glm";
import { queryOpencodeGo } from "./sources/opencode-go";
import type {
  ClaudeAccountUsage,
  ProviderId,
  ProviderSnapshot,
  QuotaResult,
  UsageWindow,
} from "./sources/types";

type TuiContext = ReturnType<typeof usePlugin>;

/** How long the last successful usage stays displayed when a refresh errors. */
const STALE_OK_MS = 10 * 60_000;

// Claude fetch cadence (api.anthropic.com 429s under aggressive polling):
// a turn resets the ramp to the base, idle time doubles it up to the max.
const CLAUDE_BASE_INTERVAL_MS = 2 * 60_000;
const CLAUDE_MAX_INTERVAL_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Provider registry + shared state
// ---------------------------------------------------------------------------

const PROVIDERS: Record<ProviderId, { label: string; query: (opts: UsageOptions) => Promise<QuotaResult> }> = {
  codex: { label: "Codex", query: () => queryCodex() },
  claude: { label: "Claude", query: () => queryClaude() },
  glm: { label: "GLM", query: () => queryGlm() },
  "opencode-go": {
    label: "Go",
    query: (opts) => queryOpencodeGo({ apiKey: opts.goApiKey, baseUrl: opts.goBaseUrl }),
  },
};

/** Fixed label column width (from the full registry) so the 5h/7d bars
 * align across providers and never jump when one is offline or erroring. */
const LABEL_WIDTH = Math.max(...PROVIDER_IDS.map((id) => PROVIDERS[id]!.label.length));

function initialSnapshot(id: ProviderId): ProviderSnapshot {
  return { id, label: PROVIDERS[id]!.label, state: { status: "missing" }, updatedAt: 0 };
}

interface UsageState {
  providers: Record<ProviderId, ProviderSnapshot>;
}

function initialState(): UsageState {
  return {
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, initialSnapshot(id)])) as Record<
      ProviderId,
      ProviderSnapshot
    >,
  };
}

/** Defensive read: durable storage may predate a provider (e.g. "opencode-go"
 * added in a later version), so a key can be absent - fall back to fresh. */
function snapOf(state: UsageState, id: ProviderId): ProviderSnapshot {
  return state.providers[id] ?? initialSnapshot(id);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const WINDOW_ORDER: Record<string, number> = { "5h": 0, "7d": 1, "30d": 2, "1m": 2 };

/** 5h first, then 7d/30d, anything else last. */
function sortedWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return [...windows].sort((a, b) => (WINDOW_ORDER[a.label] ?? 9) - (WINDOW_ORDER[b.label] ?? 9));
}

/** Remaining quota, 0..100 (the API reports utilization). */
function remaining(window: UsageWindow): number {
  return Math.min(100, Math.max(0, 100 - window.usedPct));
}

type Feedback = "success" | "warning" | "error";

function feedbackFor(remainingPct: number): Feedback {
  if (remainingPct <= 20) return "error";
  if (remainingPct <= 50) return "warning";
  return "success";
}

function windowsOf(snapshot: ProviderSnapshot): readonly UsageWindow[] {
  return snapshot.state.status === "ok" ? snapshot.state.windows : [];
}

function accountsOf(snapshot: ProviderSnapshot): readonly ClaudeAccountUsage[] {
  return snapshot.state.status === "ok" ? (snapshot.state.accounts ?? []) : [];
}

function feedbackColor(ctx: TuiContext, window: UsageWindow) {
  return ctx.theme.text.feedback[feedbackFor(remaining(window))].base;
}

/** "not connected" or a short, human error label. */
function missingText(snapshot: ProviderSnapshot): string {
  if (snapshot.state.status !== "error") return "not connected";
  return shortStatus(snapshot.state.message);
}

/** Short time until the next allowed attempt, e.g. "3m" or "45s"; undefined when not limited. */
function limitedCountdown(snapshot: ProviderSnapshot): string | undefined {
  const until = snapshot.limitedUntil;
  if (!until) return undefined;
  const ms = until - Date.now();
  if (ms <= 0) return undefined;
  return ms >= 90_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** Critical window = least remaining, e.g. "0% 4h 7m". */
function windowsSummary(windows: readonly UsageWindow[]): string {
  if (windows.length === 0) return "";
  const critical = windows.reduce((a, b) => (remaining(a) <= remaining(b) ? a : b));
  const pct = `${Math.round(remaining(critical))}%`;
  const reset = formatReset(critical.resetsAt);
  return reset ? `${pct} ${reset}` : pct;
}

function summary(snapshot: ProviderSnapshot): string {
  return windowsSummary(windowsOf(snapshot));
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Mounts the /usage command. Keymap layers must be created inside a rendered component. */
function UsageCommands(props: {
  ctx: TuiContext;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  enabled: (id: ProviderId) => boolean;
  state: UsageState;
}) {
  props.ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "usage.refresh",
        title: "Refresh usage",
        group: "Usage",
        palette: true,
        slash: { name: "usage" },
        suggested: true,
        run: async () => {
          await props.refresh({ force: true });
          const lines = PROVIDER_IDS.filter((id) => props.enabled(id) && snapOf(props.state, id).state.status === "ok")
            .flatMap((id) => {
              const snap = snapOf(props.state, id);
              const limited = limitedCountdown(snap);
              const suffix = limited ? ` (limited ${limited})` : "";
              // Claude: one line per connected account.
              const accounts = accountsOf(snap);
              if (snap.id === "claude" && accounts.length > 0) {
                return accounts.map((account) =>
                  account.windows.length > 0
                    ? `${snap.label} ${account.label} ${windowsSummary(account.windows)}`
                    : `${snap.label} ${account.label}: ${shortStatus(account.message)}`,
                );
              }
              return [`${snap.label} ${summary(snap)}${suffix}`];
            });
          props.ctx.ui.toast.show({
            title: "Usage",
            message: lines.length > 0 ? lines.join("\n") : "No usage data available",
            variant: "info",
          });
        },
      },
    ],
  }));
  return null;
}

/** The 5h session window (fallback: first window), used in the footer line. */
function fiveHour(snapshot: ProviderSnapshot): UsageWindow | undefined {
  return (
    windowsOf(snapshot).find((window) => window.label === "5h") ??
    sortedWindows(windowsOf(snapshot))[0]
  );
}

function StatusLine(props: { ctx: TuiContext; state: UsageState; enabled: (id: ProviderId) => boolean }) {
  const theme = props.ctx.theme;
  const visible = () =>
    PROVIDER_IDS.filter((id) => {
      const snap = snapOf(props.state, id);
      return props.enabled(id) && snap.state.status === "ok" && fiveHour(snap) !== undefined;
    });
  return (
    <Show when={visible().length > 0}>
      <box flexDirection="row" gap={0}>
        <For each={visible()}>
          {(id, index) => {
            const snap = () => snapOf(props.state, id);
            const window = () => fiveHour(snap())!;
            return (
              <>
                <Show when={index() > 0}>
                  <text fg={theme.text.muted} wrapMode="none">
                    {" / "}
                  </text>
                </Show>
                <text fg={theme.text.base} wrapMode="none">
                  {snap().label}
                </text>
                <text fg={theme.text.muted} wrapMode="none">
                  {` ${Math.round(remaining(window()))}%`}
                </text>
              </>
            );
          }}
        </For>
      </box>
    </Show>
  );
}

/** One usage window row: `<label> <window> <bar> <pct> <reset> [⟳ cooldown]`. */
function WindowRow(props: {
  ctx: TuiContext;
  label: string;
  window: UsageWindow;
  showLimited?: string | undefined;
}) {
  const theme = props.ctx.theme;
  return (
    <box flexDirection="row" gap={0}>
      <text fg={theme.text.base} wrapMode="none">
        {props.label}
      </text>
      <text fg={theme.text.muted} wrapMode="none">
        {` ${props.window.label} `}
      </text>
      <text fg={feedbackColor(props.ctx, props.window)} wrapMode="none">
        {renderBar(remaining(props.window), 12)}
      </text>
      <text fg={theme.text.muted} wrapMode="none">
        {` ${Math.round(remaining(props.window))}% ${formatReset(props.window.resetsAt)}`}
      </text>
      <Show when={props.showLimited}>
        <text fg={theme.text.muted} wrapMode="none">
          {` ⟳ ${props.showLimited}`}
        </text>
      </Show>
    </box>
  );
}

function ProviderWindowRows(props: { ctx: TuiContext; snapshot: ProviderSnapshot }) {
  return (
    <For each={sortedWindows(windowsOf(props.snapshot))}>
      {(window, index) => (
        <WindowRow
          ctx={props.ctx}
          label={index() === 0 ? props.snapshot.label.padEnd(LABEL_WIDTH) : " ".repeat(LABEL_WIDTH)}
          window={window}
          showLimited={index() === 0 ? limitedCountdown(props.snapshot) : undefined}
        />
      )}
    </For>
  );
}

/** Per-account rows for Claude: windows per account, masked email underneath. */
function ClaudeAccountRows(props: { ctx: TuiContext; snapshot: ProviderSnapshot }) {
  const theme = props.ctx.theme;
  return (
    <For each={accountsOf(props.snapshot)}>
      {(account, accountIndex) => (
        <>
          <Show when={accountIndex() > 0}>
            <text wrapMode="none">{" "}</text>
          </Show>
          <Show
            when={account.windows.length > 0}
            fallback={
              <text fg={theme.text.muted} wrapMode="none">
                {`${" ".repeat(LABEL_WIDTH)} ${shortStatus(account.message)}`}
              </text>
            }
          >
            <For each={sortedWindows(account.windows)}>
              {(window, index) => (
                <WindowRow
                  ctx={props.ctx}
                  label={
                    accountIndex() === 0 && index() === 0
                      ? props.snapshot.label.padEnd(LABEL_WIDTH)
                      : " ".repeat(LABEL_WIDTH)
                  }
                  window={window}
                  showLimited={
                    accountIndex() === 0 && index() === 0
                      ? limitedCountdown(props.snapshot)
                      : undefined
                  }
                />
              )}
            </For>
          </Show>
          <text fg={theme.text.muted} wrapMode="none">
            {`${" ".repeat(LABEL_WIDTH + 4)}${account.label}`}
          </text>
        </>
      )}
    </For>
  );
}

function SidebarCard(props: { ctx: TuiContext; state: UsageState; enabled: (id: ProviderId) => boolean }) {
  const ctx = props.ctx;
  const theme = ctx.theme;
  // Hide providers that are disabled in options or have no credentials at all.
  const visible = () =>
    PROVIDER_IDS.filter((id) => props.enabled(id) && snapOf(props.state, id).state.status !== "missing");
  return (
    <box flexDirection="column">
      <For each={visible()}>
        {(id, index) => {
          const snap = () => snapOf(props.state, id);
          return (
            <>
              <Show when={index() > 0}>
                <text fg={theme.text.muted} wrapMode="none">
                  {" "}
                </text>
              </Show>
              <Show
                when={snap().state.status === "ok"}
                fallback={
                  <text fg={theme.text.muted} wrapMode="none">
                    {`${snap().label.padEnd(LABEL_WIDTH)} ${missingText(snap())}`}
                  </text>
                }
              >
                <Show
                  when={accountsOf(snap()).length > 0}
                  fallback={<ProviderWindowRows ctx={ctx} snapshot={snap()} />}
                >
                  <ClaudeAccountRows ctx={ctx} snapshot={snap()} />
                </Show>
              </Show>
            </>
          );
        }}
      </For>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "usage",
  setup(context) {
    const options = parseOptions(context.options);
    const refreshMs = options.refreshMs;
    const enabled = (id: ProviderId): boolean => options.providers[id];
    const instanceId = Math.random().toString(36).slice(2, 8);

    setUsageLog(options.log);
    setClaudeUserAgent(options.claudeUserAgent);
    setCredentialLister(async () =>
      (await context.client.credential.list()).map(
        (entry): StoredCredential => ({
          id: entry.id,
          integrationID: entry.integrationID,
          label: entry.label,
          active: entry.active,
          value: entry.value as unknown as Record<string, unknown>,
        }),
      ),
    );

    writeUsageLog({ event: "init", instance: instanceId, version: context.app.version });

    // Durable storage: survives TUI restarts and syncs across TUI instances,
    // so the last good usage data (and its "limited" flag) is always there.
    const [state, mutate] = context.storage.store<UsageState>("usage-state", {
      initial: initialState(),
    });

    // Backfill keys missing from state persisted by older versions (e.g. a
    // provider added later) so every render path sees a complete record.
    mutate((draft: UsageState) => {
      for (const id of PROVIDER_IDS) {
        draft.providers[id] ??= initialSnapshot(id);
      }
    });

    let inFlight: Promise<void> | undefined;
    let claudeRampMs = CLAUDE_BASE_INTERVAL_MS;
    // A refresh requested while one runs waits for it instead of returning stale data.
    const refresh = (opts?: { force?: boolean }): Promise<void> => {
      inFlight ??= runRefresh(opts).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    const runRefresh = async (opts?: { force?: boolean }): Promise<void> => {
      await Promise.all(
        PROVIDER_IDS.filter(enabled).map(async (id) => {
          const before = snapOf(state, id);
          const now0 = Date.now();
          // Shared rate-limit cooldown (persisted, syncs across TUI
          // instances): do not call the API at all.
          if (before.limitedUntil && before.limitedUntil > now0) {
            void writeUsageLog({
              event: "skip",
              instance: instanceId,
              provider: id,
              reason: "limited",
              limitedUntil: before.limitedUntil,
            });
            return;
          }
          // Claude: the timer tick is a no-op while the persisted cache
          // window (idle ramp, 2..15 min) is fresh; turns and /usage force.
          if (id === "claude" && !opts?.force && (before.cacheUntil ?? 0) > now0) {
            void writeUsageLog({
              event: "skip",
              instance: instanceId,
              provider: id,
              reason: "cached",
              cacheUntil: before.cacheUntil,
            });
            return;
          }
          const t0 = Date.now();
          const fixture = fixturePath();
          const result = fixture ? await queryFixture(fixture, id) : await PROVIDERS[id]!.query(options);
          const ms = Date.now() - t0;
          void writeUsageLog({
            event: "refresh",
            instance: instanceId,
            provider: id,
            ms,
            outcome: result.ok ? (result.limitedUntil ? "limited" : "ok") : result.kind,
            limitedUntil: result.ok ? result.limitedUntil : result.limitedUntil,
            cooldownIn: result.limitedUntil
              ? Math.round((result.limitedUntil - Date.now()) / 1000) + "s"
              : undefined,
            message: result.ok ? undefined : result.message.slice(0, 120),
          });
          mutate((draft: UsageState) => {
            const previous = draft.providers[id] ?? initialSnapshot(id);
            const now = Date.now();
            // A shared cooldown is active (persisted, syncs across TUI
            // instances): keep the snapshot and do not call the API.
            if (previous.limitedUntil && previous.limitedUntil > now) {
              void writeUsageLog({
                event: "skip",
                instance: instanceId,
                provider: id,
                limitedUntil: previous.limitedUntil,
              });
              return;
            }
            // Keep the last good data when a provider hiccups (429, flaky
            // 401, timeout): a transient error must not blank the card.
            if (!result.ok && result.kind === "error") {
              if (result.limitedUntil && previous.state.status === "ok") {
                draft.providers[id] = { ...previous, limitedUntil: result.limitedUntil };
                return;
              }
              if (previous.state.status === "ok" && now - previous.updatedAt < STALE_OK_MS) {
                return;
              }
            }
            // cacheUntil drives the next allowed fetch: the source's own
            // window when it served cache, otherwise the idle ramp (fresh
            // HTTP call only). A rate-limit cooldown supersedes it.
            let cacheUntil: number | undefined;
            if (result.ok && !result.limitedUntil) {
              if (result.cacheUntil !== undefined) {
                cacheUntil = result.cacheUntil;
              } else if (id === "claude") {
                cacheUntil = Date.now() + claudeRampMs;
                claudeRampMs = Math.min(CLAUDE_MAX_INTERVAL_MS, claudeRampMs * 2);
              }
            }
            draft.providers[id] = {
              id,
              label: PROVIDERS[id]!.label,
              updatedAt: now,
              limitedUntil: result.limitedUntil,
              cacheUntil,
              state: result.ok
                ? {
                    status: "ok",
                    plan: result.plan,
                    windows: result.windows,
                    accounts: result.accounts,
                  }
                : result.kind === "missing"
                  ? { status: "missing", message: result.message }
                  : { status: "error", message: result.message },
            };
          });
        }),
      );
    };

    let lastExecutionRefresh = 0;
    const stopExecutionListener = context.data.on("session.execution.succeeded", () => {
      const now = Date.now();
      if (now - lastExecutionRefresh < 10_000) return;
      lastExecutionRefresh = now;
      // A turn may have consumed quota: schedule the next Claude fetch soon.
      claudeRampMs = CLAUDE_BASE_INTERVAL_MS;
      void refresh();
    });

    const timer = setInterval(() => void refresh(), refreshMs);
    // De-synchronize instances so they don't all fire in the same second.
    const initialTimer = setTimeout(() => void refresh({ force: true }), Math.random() * 3_000);

    const unregisterSlots: (() => void)[] = [];

    if (options.sidebar !== false) {
      unregisterSlots.push(
        context.ui.slot({
          append: "sidebar.content",
          render: () => <SidebarCard ctx={context} state={state} enabled={enabled} />,
        }),
      );
    }
    if (options.footer !== false) {
      unregisterSlots.push(
        context.ui.slot({
          append: "prompt.footer.status",
          render: () => <StatusLine ctx={context} state={state} enabled={enabled} />,
        }),
      );
    }
    if (options.home !== false) {
      unregisterSlots.push(
        context.ui.slot({
          append: "home.footer",
          render: () => (
            <box justifyContent="center">
              <StatusLine ctx={context} state={state} enabled={enabled} />
            </box>
          ),
        }),
      );
    }

    unregisterSlots.push(
      context.ui.slot({
        append: "app",
        render: () => <UsageCommands ctx={context} refresh={refresh} enabled={enabled} state={state} />,
      }),
    );

    return () => {
      clearInterval(timer);
      clearTimeout(initialTimer);
      stopExecutionListener();
      setCredentialLister(undefined);
      for (const unregister of unregisterSlots) unregister();
    };
  },
});
