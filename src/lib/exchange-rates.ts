import { sql } from "drizzle-orm";
import type { SharedDb } from "./db.js";

const EXCHANGE_RATE_API_URL = "https://open.er-api.com/v6/latest/USD";

export type ExchangeRates = Record<string, number>;

interface ExchangeRateApiResponse {
  result: string;
  time_last_update_unix: number;
  time_next_update_unix: number;
  rates: ExchangeRates;
}

async function fetchFromApi(): Promise<ExchangeRateApiResponse> {
  const res = await fetch(EXCHANGE_RATE_API_URL);
  if (!res.ok) {
    throw new Error(`Exchange rate API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as ExchangeRateApiResponse;

  if (data.result !== "success") {
    throw new Error(`Exchange rate API returned result: ${data.result}`);
  }

  return data;
}

const ENSURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS exchange_rate_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_currency TEXT NOT NULL DEFAULT 'USD',
    rates_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    next_update_at INTEGER NOT NULL
  )
`;

export async function getExchangeRates(
  shared: SharedDb,
): Promise<ExchangeRates> {
  await shared.run(sql.raw(ENSURE_TABLE_SQL));

  const rows = await shared.all<{
    rates_json: string;
    next_update_at: number;
  }>(sql`SELECT rates_json, next_update_at FROM exchange_rate_cache WHERE id = 1`);
  const row = rows[0];

  const nowUnix = Math.floor(Date.now() / 1000);

  if (row && nowUnix < row.next_update_at) {
    return JSON.parse(row.rates_json) as ExchangeRates;
  }

  try {
    const data = await fetchFromApi();

    await shared.run(sql`
      INSERT INTO exchange_rate_cache (id, base_currency, rates_json, fetched_at, next_update_at)
      VALUES (1, 'USD', ${JSON.stringify(data.rates)}, ${data.time_last_update_unix}, ${data.time_next_update_unix})
      ON CONFLICT (id) DO UPDATE SET
        rates_json = excluded.rates_json,
        fetched_at = excluded.fetched_at,
        next_update_at = excluded.next_update_at
    `);

    return data.rates;
  } catch (err) {
    // If the API is down but we have stale cached data, use it
    if (row) {
      return JSON.parse(row.rates_json) as ExchangeRates;
    }
    throw err;
  }
}

// Convert between any two currencies using USD as the pivot.
// Rates are all relative to USD (e.g., rates["EUR"] = 0.88 means 1 USD = 0.88 EUR).
export function convertCurrency(
  amount: number,
  from: string,
  to: string,
  rates: ExchangeRates,
): number {
  if (from === to) return amount;

  const fromRate = rates[from.toUpperCase()];
  const toRate = rates[to.toUpperCase()];

  if (fromRate == null) {
    throw new Error(`No exchange rate for currency: ${from}`);
  }
  if (toRate == null) {
    throw new Error(`No exchange rate for currency: ${to}`);
  }

  return amount * (toRate / fromRate);
}
