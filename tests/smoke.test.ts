import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("environment config", () => {
  it("normalizes default currency from environment", async () => {
    vi.stubEnv("DEFAULT_CURRENCY", "usd");
    vi.resetModules();

    const { env } = await import("../src/config/env.js");

    expect(env.DEFAULT_CURRENCY).toBe("USD");
  });

  it("falls back to USD when DEFAULT_CURRENCY is unset", async () => {
    delete process.env.DEFAULT_CURRENCY;
    vi.resetModules();

    const { env } = await import("../src/config/env.js");

    expect(env.DEFAULT_CURRENCY).toBe("USD");
  });

  it("rejects invalid DEFAULT_CURRENCY values", async () => {
    vi.stubEnv("DEFAULT_CURRENCY", "US1");
    vi.resetModules();
    await expect(import("../src/config/env.js")).rejects.toThrowError();
  });
});
