/**
 * Precompiles src/tui.tsx to dist/tui.js with the Solid transform.
 * The host skips that transform for files under node_modules (anomalyco/opencode#39986),
 * so plugins installed from GitHub must ship compiled JS. Run: bun run compile
 */

import solidPlugin from "@opentui/solid/bun-plugin";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { HOST_MODULES } from "./compile-config";


const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");

await rm(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(root, "src", "tui.tsx")],
  outdir,
  target: "bun",
  format: "esm",
  external: [...HOST_MODULES],
  plugins: [solidPlugin],
  root: join(root, "src"),
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const output of result.outputs) {
  // Bun labels modules relative to the cwd; normalize so dist/ is identical on every machine.
  const code = (await Bun.file(output.path).text()).replace(/^\/\/ .*?[/\\]src[/\\]/gm, "// src/");
  await Bun.write(output.path, code);
  console.log(output.path);
}
