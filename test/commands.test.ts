import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// OpenCode 2.3 added a built-in /usage dialog that wins over a plugin command
// with the same name (issue #12). The plugin must answer to a name that does
// not clash, while staying reachable from the palette.
describe("refresh command registration", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "tui.tsx"), "utf8");

  test("slash name does not clash with the built-in /usage", () => {
    expect(source).toContain('name: "refresh-usage"');
    expect(source).not.toContain('name: "usage"');
  });

  test("/usage stays as an alias for older OpenCode versions", () => {
    expect(source).toContain('aliases: ["usage"]');
  });

  test("palette entry is kept", () => {
    expect(source).toContain('title: "Refresh usage"');
    expect(source).toContain("palette: true");
  });
});
