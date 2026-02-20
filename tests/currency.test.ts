import { describe, expect, it } from "vitest";

import { CurrencyCodeSchema } from "../src/shared/currency.js";

describe("currency schema", () => {
  it("normalizes lowercase and surrounding spaces", () => {
    expect(CurrencyCodeSchema.parse(" usd ")).toBe("USD");
  });

  it("rejects invalid currency codes (non-letter or wrong length)", () => {
    expect(() => CurrencyCodeSchema.parse("US1")).toThrowError();
    expect(() => CurrencyCodeSchema.parse("US")).toThrowError();
    expect(() => CurrencyCodeSchema.parse("USDD")).toThrowError();
  });
});
