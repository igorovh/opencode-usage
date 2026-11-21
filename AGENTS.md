# Agent notes

## Demo recordings

- `bun run record -- --out demo.gif --step "key ctrl+p" --step "type Refresh usage" --step "key Enter"
  --step "expect Claude jo***@example.com"` records the real OpenCode TUI with this checkout's plugin to a GIF,
  through [opencode-tui-recorder](https://github.com/igorovh/opencode-tui-recorder) and `recorder.config.ts`. It
  needs `opencode`, `ttyd` and `ffmpeg` on `PATH` (or `OPENCODE_BIN` and `TTYD_BIN`) and Playwright's Chromium.
  Run it without steps to see the step list.
- `bun run tui serve` keeps a recording open, and `bun run tui begin`, `bun run tui <step>`, `bun run tui screen`,
  `bun run tui rec-start` and `bun run tui rec-stop --out demo.gif` drive it one step at a time; every step
  prints the screen. tidy's review uses this to try steps before it records.
- The recording opens one session, so the sidebar card, the footer line and the toast all show. No API is called:
  `recorder.config.ts` points `OPENCODE_USAGE_FIXTURE` at a copy of `docs/demo-fixture.json`.
- `fixture <json>` replaces whole providers in that copy, for example
  `fixture {"codex":{"windows":[{"label":"5h","usedPct":95,"resetsInMin":30}]}}`, and `"glm":null` hides GLM.
  The plugin reads it on the next refresh, so run "Refresh usage" after it.
- Run the command from the palette (`key ctrl+p`, `type Refresh usage`, `key Enter`). On OpenCode 2.3.2, `/usage` and
  Enter open OpenCode's own usage dialog instead of the plugin's toast.
- `--options '{"footer":false}'` passes plugin options and `--plugin <path>` records another checkout, such as a
  worktree of the base branch.
- `expect <text>` and `expect-not <text>` steps fail the recording when the screen does not match, so a GIF
  doubles as a test. Put them after every action. The toast lists each provider's lowest window, such as
  `Go 26% 19d`, while the footer shows the 5-hour window, such as `Go 96%`. A failed step stops the steps but
  still writes the GIF, then exits with 1. A broken recording, such as an unknown step, invalid JSON or a timeout,
  exits with 2.
- A check in a before-and-after recording should pass on the PR branch and fail on the base branch. A check
  that passes on both, such as `expect Codex 82%`, proves nothing about the change.
