// How `bun run record` and `bun run tui` set up the real OpenCode TUI with this plugin (opencode-tui-recorder).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineRecorder } from "opencode-tui-recorder";

// The plugin reads made-up usage from this file instead of the APIs. The recorder copies the
// environment when a recording starts, so the variable is set here and the file filled in by seed.
const fixture = path.join(os.tmpdir(), `opencode-usage-fixture-${process.pid}.json`);
process.env["OPENCODE_USAGE_FIXTURE"] = fixture;
process.on("exit", () => rmSync(fixture, { force: true }));

export default defineRecorder({
  config: ({ plugin, options }) => ({ "cli.json": { plugins: [{ package: plugin, options }] } }),
  sessions: [{ project: "acme-api", title: "Retry failed billing webhooks" }],
  // The usage card lives in the session sidebar; the home screen shows only the one-line summary.
  attach: true,
  ready: {
    label: "the usage numbers",
    test: (lines) => lines.some((line) => /\b(Codex|Claude|GLM|Go) \d+%/.test(line)),
  },
  async seed() {
    writeFileSync(fixture, readFileSync(path.join(import.meta.dir, "docs", "demo-fixture.json")));
  },
  steps: {
    fixture: {
      usage: 'fixture <json>            replace providers in the made-up usage, such as {"glm":null}; /usage shows it',
      run: async (ctx) => {
        const current = JSON.parse(readFileSync(fixture, "utf8")) as Record<string, unknown>;
        writeFileSync(fixture, JSON.stringify({ ...current, ...(JSON.parse(ctx.arg) as Record<string, unknown>) }));
      },
    },
  },
});
