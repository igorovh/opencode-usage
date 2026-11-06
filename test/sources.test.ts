import { describe, expect, test } from "bun:test";
import { maskEmail, parseWindows as parseClaude } from "../src/sources/claude";
import { parseWindows as parseCodex } from "../src/sources/codex";
import { parseWindows as parseGlm } from "../src/sources/glm";
import { parseWindows as parseGo, resolveBaseUrl } from "../src/sources/opencode-go";
import { HttpError, rateLimitedUntil } from "../src/sources/http";

describe("Codex", () => {
  test("labels windows by length and converts remaining to used", () => {
    const windows = parseCodex({
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { remaining_percent: 70, limit_window_seconds: 604_800 },
      },
    });
    expect(windows.map((w) => [w.label, w.usedPct])).toEqual([["5h", 12], ["7d", 30]]);
    expect(windows[0]!.resetsAt).toBe(new Date(1_800_000_000_000).toISOString());
  });
});

describe("Claude", () => {
  test("falls back to the OAuth apps weekly window", () => {
    const windows = parseClaude({
      five_hour: { utilization: 40, resets_at: "2026-01-01T05:00:00Z" },
      seven_day_oauth_apps: { utilization: 150 },
    });
    expect(windows.map((w) => [w.label, w.usedPct])).toEqual([["5h", 40], ["7d", 100]]);
  });

  test("maskEmail keeps the domain only", () => {
    expect(maskEmail("john@example.com")).toBe("jo***@example.com");
    expect(maskEmail("broken")).toBe("***");
  });
});

describe("GLM", () => {
  test("keeps token windows and skips MCP time limits", () => {
    const windows = parseGlm(
      {
        success: true,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: 55 },
            { type: "TIME_LIMIT", unit: 5, percentage: 99 },
          ],
        },
      },
      "zai",
    );
    expect(windows.map((w) => [w.label, w.usedPct])).toEqual([["5h", 55]]);
  });

  test("surfaces Z.ai API errors", () => {
    expect(() => parseGlm({ success: false, code: 401, msg: "bad key" }, "zai")).toThrow("bad key");
  });
});

describe("OpenCode Go", () => {
  test("maps rolling/weekly/monthly windows", () => {
    const windows = parseGo({ usage: { rolling: { percent: 10 }, monthly: { percent: 80, resetsAt: "x" } } });
    expect(windows).toEqual([
      { label: "5h", usedPct: 10, resetsAt: undefined },
      { label: "1m", usedPct: 80, resetsAt: undefined },
    ]);
  });

  test("baseUrl must be https unless it is localhost", () => {
    expect(resolveBaseUrl("https://example.com/go/")).toBe("https://example.com/go");
    expect(resolveBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(() => resolveBaseUrl("http://example.com")).toThrow();
  });
});

describe("rate limits", () => {
  test("uses Retry-After when present and a default otherwise", () => {
    const now = 1_000;
    expect(rateLimitedUntil(new HttpError(429, "u", 30_000), now)).toBe(31_000);
    expect(rateLimitedUntil(new HttpError(429, "u"), now)).toBe(now + 5 * 60_000);
    expect(rateLimitedUntil(new HttpError(500, "u"), now)).toBeUndefined();
  });
});
