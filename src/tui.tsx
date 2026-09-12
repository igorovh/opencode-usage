/**
 * usage - OpenCode 2 (beta) TUI plugin.
 *
 * Shows Codex / Claude / GLM Coding Plan usage:
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
import { formatReset, renderBar } from "./format";
import { writeUsageLog } from "./sources/log";
import { queryClaude } from "./sources/claude";
import { queryCodex } from "./sources/codex";
import { queryGlm } from "./sources/glm";
import type { ProviderId, ProviderSnapshot, UsageWindow } from "./sources/types";

type TuiContext = ReturnType<typeof usePlugin>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface UsageOptions {
  /** Refresh interval in ms (minimum 15000). Default 60000. */
  refreshMs?: number;
  /** Render the sidebar card. Default true. */
  sidebar?: boolean;
  /** Render the prompt footer line. Default true. */
  footer?: boolean;
  /** Render the home screen line. Default true. */
  home?: boolean;
  /** Enable/disable individual providers. Default: all enabled. */
  providers?: Partial<Record<ProviderId, boolean>>;
}

const DEFAULT_REFRESH_MS = 60_000;
const MIN_REFRESH_MS = 15_000;
/** How long the last successful usage stays displayed when a refresh errors. */
const STALE_OK_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Provider registry + shared state
// ---------------------------------------------------------------------------

const PROVIDERS: Record<ProviderId, { label: string; query: () => Promise<QueryOutcome> }> = {
  codex: { label: "Codex", query: () => queryCodex() },
  claude: { label: "Claude", query: () => queryClaude() },
  glm: { label: "GLM", query: () => queryGlm() },
};

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Fixed label column width (from the full registry) so the 5h/7d bars
 * align across providers and never jump when one is offline or erroring. */
const LABEL_WIDTH = Math.max(...PROVIDER_IDS.map((id) => PROVIDERS[id]!.label.length));

type QueryOutcome = Awaited<ReturnType<typeof queryCodex>>;

function initialSnapshot(id: ProviderId): ProviderSnapshot {
  return { id, label: PROVIDERS[id]!.label, state: { status: "missing" }, updatedAt: 0 };
}

interface UsageState {
  providers: Record<ProviderId, ProviderSnapshot>;
}

function initialState(): UsageState {
  return {
    providers: {
      codex: initialSnapshot("codex"),
      claude: initialSnapshot("claude"),
      glm: initialSnapshot("glm"),
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const WINDOW_ORDER: Record<string, number> = { "5h": 0, "7d": 1, "30d": 2 };

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
  if (remainingPct <= 10) return "error";
  if (remainingPct <= 30) return "warning";
  return "success";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function windowsOf(snapshot: ProviderSnapshot): readonly UsageWindow[] {
  return snapshot.state.status === "ok" ? snapshot.state.windows : [];
}

function feedbackColor(ctx: TuiContext, window: UsageWindow) {
  return ctx.theme.text.feedback[feedbackFor(remaining(window))].default;
}

/** "not connected" or a short, human error label. */
function missingText(snapshot: ProviderSnapshot): string {
  if (snapshot.state.status !== "error") return "not connected";
  const message = snapshot.state.message;
  if (/HTTP 429|rate limit/i.test(message)) {
    const wait = message.match(/retry in (\d+[ms])/i)?.[1];
    return wait ? `rate limited (${wait})` : "rate limited";
  }
  if (/HTTP 40[13]|unauthorized|expired/i.test(message)) return "login required";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/No .* token|connect|env/i.test(message)) return "not connected";
  return truncate(message, 24);
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
function summary(snapshot: ProviderSnapshot): string {  const windows = windowsOf(snapshot);
  if (windows.length === 0) return "";
  const critical = windows.reduce((a, b) => (remaining(a) <= remaining(b) ? a : b));
  const pct = `${Math.round(remaining(critical))}%`;
  const reset = formatReset(critical.resetsAt);
  return reset ? `${pct} ${reset}` : pct;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Mounts the /usage command. Keymap layers must be created inside a rendered component. */
function UsageCommands(props: {
  ctx: TuiContext;
  refresh: () => Promise<void>;
  nextRefresh: () => number;
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
          await props.refresh();
          const lines = PROVIDER_IDS.filter((id) => props.state.providers[id]!.state.status === "ok").map(
            (id) => {
              const snap = props.state.providers[id]!;
              let line = `${snap.label} ${summary(snap)}`;
              const limited = limitedCountdown(snap);
              if (limited) {
                line += ` (limited ${limited})`;
              } else if (snap.id === "claude" && props.nextRefresh() > Date.now()) {
                line += ` (refresh in ${Math.max(1, Math.round((props.nextRefresh() - Date.now()) / 1000))}s)`;
              }
              return line;
            },
          );
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

function StatusLine(props: { ctx: TuiContext; state: UsageState }) {
  const ctx = props.ctx;
  const visible = () =>
    PROVIDER_IDS.filter((id) => {
      const snap = props.state.providers[id]!;
      return snap.state.status === "ok" && fiveHour(snap) !== undefined;
    });
  return (
    <Show
      when={visible().length > 0}
      fallback={
        <text fg={ctx.theme.text.subdued} wrapMode="none">
          usage: no data
        </text>
      }
    >
      <box flexDirection="row" gap={0}>
        <For each={visible()}>
          {(id, index) => {
            const snap = () => props.state.providers[id]!;
            const window = () => fiveHour(snap())!;
            return (
              <>
                <Show when={index() > 0}>
                  <text fg={ctx.theme.text.subdued} wrapMode="none">
                    {" / "}
                  </text>
                </Show>
                <text fg={ctx.theme.text.default} wrapMode="none">
                  {snap().label}
                </text>
                <text fg={ctx.theme.text.subdued} wrapMode="none">
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

function SidebarCard(props: { ctx: TuiContext; state: UsageState }) {
  const ctx = props.ctx;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={ctx.theme.text.subdued} wrapMode="none">
        Usage
      </text>
      <text wrapMode="none">{" "}</text>
      <For each={PROVIDER_IDS}>
        {(id, index) => {
          const snap = () => props.state.providers[id]!;
          return (
            <>
              <Show when={index() > 0}>
                <text fg={ctx.theme.text.subdued} wrapMode="none">
                  {" "}
                </text>
              </Show>
              <Show
                when={snap().state.status === "ok"}
                fallback={
                  <text fg={ctx.theme.text.subdued} wrapMode="none">
                    {`${snap().label.padEnd(LABEL_WIDTH)} ${missingText(snap())}`}
                  </text>
                }
              >
              <For each={sortedWindows(windowsOf(snap()))}>
                {(window, index) => (
                  <box flexDirection="row" gap={0}>
                    <text
                      fg={index() === 0 ? ctx.theme.text.default : ctx.theme.text.subdued}
                      wrapMode="none"
                    >
                      {index() === 0 ? snap().label.padEnd(LABEL_WIDTH) : " ".repeat(LABEL_WIDTH)}
                    </text>
                    <text fg={ctx.theme.text.subdued} wrapMode="none">
                      {` ${window.label} `}
                    </text>
                    <text fg={feedbackColor(ctx, window)} wrapMode="none">
                      {renderBar(remaining(window), 12)}
                    </text>
                    <text fg={ctx.theme.text.subdued} wrapMode="none">
                      {` ${Math.round(remaining(window))}% ${formatReset(window.resetsAt)}`}
                    </text>
                    <Show when={index() === 0 && limitedCountdown(snap())}>
                      <text fg={ctx.theme.text.subdued} wrapMode="none">
                        {` ⟳ ${limitedCountdown(snap())}`}
                      </text>
                    </Show>
                  </box>
                )}
              </For>
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
    const options = (context.options ?? {}) as UsageOptions;
    const refreshMs = Math.max(MIN_REFRESH_MS, options.refreshMs ?? DEFAULT_REFRESH_MS);
    const enabled = (id: ProviderId): boolean => options.providers?.[id] !== false;
    const instanceId = Math.random().toString(36).slice(2, 8);

    writeUsageLog({ event: "init", instance: instanceId, version: context.app.version });

    // Durable storage: survives TUI restarts and syncs across TUI instances,
    // so the last good usage data (and its "limited" flag) is always there.
    const [state, mutate] = context.storage.store<UsageState>("usage-state", {
      initial: initialState(),
    });

    let inFlight = false;
    let nextRefreshAt = 0;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        nextRefreshAt = Date.now() + refreshMs;
        await Promise.all(
          PROVIDER_IDS.filter(enabled).map(async (id) => {
            const t0 = Date.now();
            const result = await PROVIDERS[id]!.query();
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
              const previous = draft.providers[id]!;
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
              draft.providers[id] = {
                id,
                label: PROVIDERS[id]!.label,
                updatedAt: now,
                limitedUntil: result.ok ? result.limitedUntil : undefined,
                cacheUntil: result.ok ? result.cacheUntil : undefined,
                state: result.ok
                  ? { status: "ok", plan: result.plan, windows: result.windows }
                  : result.kind === "missing"
                    ? { status: "missing", message: result.message }
                    : { status: "error", message: result.message },
              };
            });
          }),
        );
      } finally {
        inFlight = false;
      }
    };

    let lastExecutionRefresh = 0;
    const stopExecutionListener = context.data.on("session.execution.succeeded", () => {
      const now = Date.now();
      if (now - lastExecutionRefresh < 10_000) return;
      lastExecutionRefresh = now;
      void refresh();
    });

    const timer = setInterval(() => void refresh(), refreshMs);
    // De-synchronize instances so they don't all fire in the same second.
    const initialTimer = setTimeout(() => void refresh(), Math.random() * 3_000);

    const unregisterSlots: (() => void)[] = [];

    if (options.sidebar !== false) {
      unregisterSlots.push(
        context.ui.slot({
          append: "sidebar.content",
          render: () => <SidebarCard ctx={context} state={state} />,
        }),
      );
    }
    if (options.footer !== false) {
      unregisterSlots.push(
        context.ui.slot({
          append: "prompt.footer.status",
          render: () => <StatusLine ctx={context} state={state} />,
        }),
      );
    }
    if (options.home !== false) {
      unregisterSlots.push(
        context.ui.slot({
          append: "home.footer",
          render: () => (
            <box justifyContent="center">
              <StatusLine ctx={context} state={state} />
            </box>
          ),
        }),
      );
    }

    unregisterSlots.push(
      context.ui.slot({
        append: "app",
        render: () => <UsageCommands ctx={context} refresh={refresh} nextRefresh={() => nextRefreshAt} state={state} />,
      }),
    );

    return () => {
      clearInterval(timer);
      clearTimeout(initialTimer);
      stopExecutionListener();
      for (const unregister of unregisterSlots) unregister();
    };
  },
});
