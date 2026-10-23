import { afterEach, describe, it, expect, vi } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { SharedDb } from "./db.js";
import { convertCurrency, getExchangeRates, type ExchangeRates } from "./exchange-rates.js";
import { requestsUsed, withRequestBudget } from "./request-budget.js";
import * as sharedSchema from "./schema-shared.js";

const rates: ExchangeRates = {
  USD: 1,
  EUR: 0.88,
  GBP: 0.75,
  JPY: 150,
};

describe("convertCurrency", () => {
  it("returns input unchanged for same currency", () => {
    expect(convertCurrency(100, "USD", "USD", rates)).toBe(100);
  });

  it("converts USD to EUR", () => {
    const result = convertCurrency(100, "USD", "EUR", rates);
    expect(result).toBeCloseTo(88);
  });

  it("converts EUR to GBP (cross-rate via USD pivot)", () => {
    // EUR -> USD -> GBP: 100 / 0.88 * 0.75
    const result = convertCurrency(100, "EUR", "GBP", rates);
    expect(result).toBeCloseTo(85.227, 2);
  });

  it("throws on unknown source currency", () => {
    expect(() => convertCurrency(100, "XXX", "USD", rates)).toThrow(
      "No exchange rate for currency: XXX",
    );
  });

  it("throws on unknown target currency", () => {
    expect(() => convertCurrency(100, "USD", "XXX", rates)).toThrow(
      "No exchange rate for currency: XXX",
    );
  });

  it("zero amount stays zero", () => {
    expect(convertCurrency(0, "USD", "EUR", rates)).toBe(0);
  });

  it("negative amounts convert correctly", () => {
    const result = convertCurrency(-50, "USD", "EUR", rates);
    expect(result).toBeCloseTo(-44);
  });
});

describe("getExchangeRates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts the rate API's request against the request budget", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        result: "success",
        time_last_update_unix: 0,
        time_next_update_unix: 0,
        rates: { USD: 1 },
      }),
    );
    // in memory, so the API is the only request
    const shared = drizzle({ client: createClient({ url: ":memory:" }), schema: sharedSchema });

    const requests = await withRequestBudget(async () => {
      await getExchangeRates(shared as SharedDb);
      return requestsUsed();
    });

    expect(requests).toBe(1);
  });
});
