import createClient from "openapi-fetch";
import type { paths, components } from "./lunch-money-api.js";

export type LmTransaction = components["schemas"]["transactionObject"];
export type LmManualAccount = components["schemas"]["manualAccountObject"];
export type LmInsertTransaction =
  components["schemas"]["insertTransactionObject"];

export function createLunchMoneyClient(apiKey: string) {
  return createClient<paths>({
    baseUrl: "https://api.lunchmoney.dev/v2",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export async function insertTransactions(
  apiKey: string,
  transactions: LmInsertTransaction[],
): Promise<LmTransaction[]> {
  const client = createLunchMoneyClient(apiKey);
  const { data, error } = await client.POST("/transactions", {
    body: {
      transactions,
      skip_duplicates: false,
      skip_balance_update: true,
    },
  });

  if (error) {
    throw new Error(`Lunch Money API error: ${JSON.stringify(error)}`);
  }

  return data.transactions;
}

export async function updateTransaction(
  apiKey: string,
  transactionId: number,
  update: components["schemas"]["updateTransactionObject"],
): Promise<void> {
  const client = createLunchMoneyClient(apiKey);
  const { error } = await client.PUT("/transactions", {
    body: {
      transactions: [{ id: transactionId, ...update }],
    },
  });

  if (error) {
    throw new Error(`Lunch Money API error: ${JSON.stringify(error)}`);
  }
}

export async function getTransactions(
  apiKey: string,
  params: {
    manual_account_id: number;
    start_date?: string;
    end_date?: string;
  },
): Promise<LmTransaction[]> {
  const client = createLunchMoneyClient(apiKey);
  const all: LmTransaction[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await client.GET("/transactions", {
      params: {
        query: {
          manual_account_id: params.manual_account_id,
          start_date: params.start_date,
          end_date: params.end_date,
          include_group_children: true,
          limit,
          offset,
        },
      },
    });

    if (error) {
      throw new Error(`Lunch Money API error: ${JSON.stringify(error)}`);
    }

    all.push(...data.transactions);
    if (!data.has_more) break;
    offset += limit;
  }

  return all;
}

export async function getManualAccounts(
  apiKey: string,
): Promise<LmManualAccount[]> {
  const client = createLunchMoneyClient(apiKey);
  const { data, error } = await client.GET("/manual_accounts");

  if (error) {
    throw new Error(`Lunch Money API error: ${JSON.stringify(error)}`);
  }

  return data.manual_accounts ?? [];
}
