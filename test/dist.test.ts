import { expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { HOST_MODULES } from "../scripts/compile-config";

// Any other import would load a second copy of a module the host already provides, or a missing package.
test("dist/tui.js imports only host modules and runtime built-ins", async () => {
  const code = await Bun.file(join(import.meta.dir, "..", "dist", "tui.js")).text();
  const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1]!);
  const allowed = (specifier: string) =>
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    builtinModules.includes(specifier) ||
    HOST_MODULES.includes(specifier);
  expect(specifiers.length).toBeGreaterThan(0);
  expect(specifiers.filter((specifier) => !allowed(specifier))).toEqual([]);
});
