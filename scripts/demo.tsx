/**
 * Renders the sidebar card and footer line with made-up data to docs/demo.png.
 * Run: bun run demo
 */

/** @jsxImportSource @opentui/solid */

import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { Resvg } from "@resvg/resvg-js";
import { join } from "node:path";
import { SidebarCard, StatusLine, type UsageState } from "../src/tui";

const hour = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms + 30_000).toISOString();

const claudeMain = [
  { label: "5h", usedPct: 36, resetsAt: at(2 * hour + 37 * 60_000) },
  { label: "7d", usedPct: 62, resetsAt: at(4 * 24 * hour + 20 * hour) },
];

const state: UsageState = {
  providers: {
    codex: {
      id: "codex",
      label: "Codex",
      updatedAt: Date.now(),
      state: { status: "ok", plan: "Plus", windows: [
        { label: "5h", usedPct: 18, resetsAt: at(2 * hour + 14 * 60_000) },
        { label: "7d", usedPct: 46, resetsAt: at(3 * 24 * hour + 18 * hour) },
      ] },
    },
    claude: {
      id: "claude",
      label: "Claude",
      updatedAt: Date.now(),
      state: {
        status: "ok",
        windows: claudeMain,
        accounts: [
          { label: "jo***@example.com", active: true, windows: claudeMain },
          { label: "an***@example.org", active: false, windows: [
            { label: "5h", usedPct: 85, resetsAt: at(41 * 60_000) },
            { label: "7d", usedPct: 23, resetsAt: at(6 * 24 * hour + 2 * hour) },
          ] },
        ],
      },
    },
    glm: {
      id: "glm",
      label: "GLM",
      updatedAt: Date.now(),
      state: { status: "ok", windows: [{ label: "5h", usedPct: 55, resetsAt: at(3 * hour + 6 * 60_000) }] },
    },
    "opencode-go": {
      id: "opencode-go",
      label: "Go",
      updatedAt: Date.now(),
      state: { status: "ok", windows: [
        { label: "5h", usedPct: 4, resetsAt: at(4 * hour) },
        { label: "7d", usedPct: 31, resetsAt: at(5 * 24 * hour) },
        { label: "1m", usedPct: 74, resetsAt: at(19 * 24 * hour) },
      ] },
    },
  },
};

const color = (hex: string) => RGBA.fromHex(hex);
const ctx = {
  theme: {
    text: {
      base: color("#e6e6e6"),
      muted: color("#808080"),
      feedback: {
        success: { base: color("#7fd88f") },
        warning: { base: color("#f5a742") },
        error: { base: color("#e06c75") },
        info: { base: color("#56b6c2") },
      },
    },
  },
} as never;

const width = 46;
const height = 20;
const setup = await testRender(
  () => (
    <box flexDirection="column" padding={1}>
      <SidebarCard ctx={ctx} state={state} enabled={() => true} />
      <text>{" "}</text>
      <StatusLine ctx={ctx} state={state} enabled={() => true} />
    </box>
  ),
  { width, height },
);
await setup.renderOnce();
const frame = setup.captureSpans();
await setup.dispose();

const cell = { w: 9.6, h: 20 };
const hex = (rgba: RGBA) =>
  `#${[rgba.r, rgba.g, rgba.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const rows = frame.lines.map((line, row) => {
  let col = 0;
  return line.spans
    .map((span) => {
      const x = col * cell.w;
      col += span.width;
      if (!span.text.trim()) return "";
      return `<text x="${x.toFixed(1)}" y="${(row + 1) * cell.h - 5}" fill="${hex(span.fg)}" xml:space="preserve">${escape(span.text)}</text>`;
    })
    .join("");
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * cell.w}" height="${height * cell.h}" font-family="Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="16">
<rect width="100%" height="100%" rx="8" fill="#141414"/>
${rows.join("\n")}
</svg>
`;
const png = new Resvg(svg, { fitTo: { mode: "zoom", value: 2 }, font: { loadSystemFonts: true } }).render().asPng();
await Bun.write(join(import.meta.dir, "..", "docs", "demo.png"), png);
console.log("docs/demo.png");
