import { describe, expect, it } from "vitest";

import { env } from "../src/config/env.js";

describe("environment config", () => {
  it("loads default currency", () => {
    expect(env.DEFAULT_CURRENCY).toBe("USD");
  });
});
