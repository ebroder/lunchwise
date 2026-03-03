import { describe, it, expect } from "vitest";
import { convertCurrency, type ExchangeRates } from "./exchange-rates.js";

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
