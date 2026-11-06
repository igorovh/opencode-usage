import { describe, expect, test } from "bun:test";
import { formatDuration, formatReset, renderBar, shortStatus } from "../src/format";

describe("format", () => {
  test("renderBar clamps and fills proportionally", () => {
    expect(renderBar(50, 10)).toBe("━━━━━─────");
    expect(renderBar(150, 4)).toBe("━━━━");
    expect(renderBar(-5, 4)).toBe("────");
  });

  test("formatDuration picks the two largest units", () => {
    expect(formatDuration(3 * 86_400_000 + 18 * 3_600_000)).toBe("3d 18h");
    expect(formatDuration(2 * 3_600_000 + 37 * 60_000)).toBe("2h 37m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
  });

  test("formatReset is empty for past or invalid timestamps", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(formatReset("2026-01-01T02:00:00Z", now)).toBe("2h");
    expect(formatReset("2025-12-31T00:00:00Z", now)).toBe("");
    expect(formatReset("nope", now)).toBe("");
  });

  test("shortStatus tells 403 apart from 401", () => {
    expect(shortStatus("Codex: forbidden - no subscription or access (HTTP 403).")).toBe("no subscription");
    expect(shortStatus("HTTP 403 from https://example.com")).toBe("no subscription");
    expect(shortStatus("Claude: unauthorized - token expired, re-authenticate.")).toBe("login required");
    expect(shortStatus("Claude: rate limited, retry in 5m.")).toBe("rate limited (5m)");
    expect(shortStatus(undefined)).toBe("not connected");
  });
});
