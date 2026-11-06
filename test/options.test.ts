import { describe, expect, test } from "bun:test";
import { DEFAULT_REFRESH_MS, MIN_REFRESH_MS, parseOptions } from "../src/options";

describe("parseOptions", () => {
  test("defaults when options are missing", () => {
    const options = parseOptions(undefined);
    expect(options.refreshMs).toBe(DEFAULT_REFRESH_MS);
    expect(options.sidebar && options.footer && options.home).toBe(true);
    expect(Object.values(options.providers).every(Boolean)).toBe(true);
    expect(options.log).toBe(false);
  });

  test("malformed refreshMs never produces a tight polling loop", () => {
    expect(parseOptions({ refreshMs: "1000" }).refreshMs).toBe(DEFAULT_REFRESH_MS);
    expect(parseOptions({ refreshMs: Number.NaN }).refreshMs).toBe(DEFAULT_REFRESH_MS);
    expect(parseOptions({ refreshMs: 10 }).refreshMs).toBe(MIN_REFRESH_MS);
  });

  test("providers can be switched off individually", () => {
    const options = parseOptions({ providers: { codex: false, glm: "no" } });
    expect(options.providers.codex).toBe(false);
    expect(options.providers.glm).toBe(true);
    expect(options.providers.claude).toBe(true);
  });

  test("apiKey is accepted as an alias for goApiKey", () => {
    expect(parseOptions({ apiKey: " key " }).goApiKey).toBe("key");
    expect(parseOptions({ goApiKey: "a", apiKey: "b" }).goApiKey).toBe("a");
  });
});
