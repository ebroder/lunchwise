import createClient from "openapi-fetch";
import type { paths, components } from "./lunch-money-api.js";
import { describeError } from "./errors.js";

export type LmTransaction = components["schemas"]["transactionObject"];
export type LmManualAccount = components["schemas"]["manualAccountObject"];
export type LmCategory = components["schemas"]["categoryObject"];
export type LmInsertTransaction = components["schemas"]["insertTransactionObject"];
export type LmSkippedDuplicate = components["schemas"]["skippedExistingExternalIdObject"];
export type LmUser = components["schemas"]["userObject"];

export function createLunchMoneyClient(apiKey: string) {
  return createClient<paths>({
    baseUrl: "https://api.lunchmoney.dev/v2",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

const LM_BATCH = 500;

export async function insertTransactions(
  apiKey: string,
  transactions: LmInsertTransaction[],
): Promise<{ transactions: LmTransaction[]; skippedDuplicates: LmSkippedDuplicate[] }> {
  const client = createLunchMoneyClient(apiKey);
  const allTransactions: LmTransaction[] = [];
  const allSkipped: LmSkippedDuplicate[] = [];

  for (let i = 0; i < transactions.length; i += LM_BATCH) {
    const { data, error, response } = await client.POST("/transactions", {
      body: {
        transactions: transactions.slice(i, i + LM_BATCH),
        apply_rules: true,
        skip_duplicates: false,
        skip_balance_update: true,
      },
    });

    if (error) {
      throw new Error(`Lunch Money API error (${response.status}): ${describeError(error)}`);
    }

    allTransactions.push(...data.transactions);
    allSkipped.push(...(data.skipped_duplicates ?? []));
  }

  return { transactions: allTransactions, skippedDuplicates: allSkipped };
}

export async function updateTransaction(
  apiKey: string,
  transactionId: number,
  update: components["schemas"]["updateTransactionObject"],
): Promise<void> {
  const client = createLunchMoneyClient(apiKey);
  const { error, response } = await client.PUT("/transactions", {
    body: {
      transactions: [{ id: transactionId, ...update }],
    },
  });

  if (error) {
    throw new Error(`Lunch Money API error (${response.status}): ${describeError(error)}`);
  }
}

export async function updateTransactions(
  apiKey: string,
  updates: Array<{ id: number } & components["schemas"]["updateTransactionObject"]>,
): Promise<void> {
  if (updates.length === 0) return;
  const client = createLunchMoneyClient(apiKey);

  for (let i = 0; i < updates.length; i += LM_BATCH) {
    const { error, response } = await client.PUT("/transactions", {
      body: { transactions: updates.slice(i, i + LM_BATCH) },
    });

    if (error) {
      throw new Error(`Lunch Money API error (${response.status}): ${describeError(error)}`);
    }
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
  const maxPages = 50;

  for (let page = 0; page < maxPages; page++) {
    const { data, error, response } = await client.GET("/transactions", {
      params: {
        query: {
          manual_account_id: params.manual_account_id,
          start_date: params.start_date,
          end_date: params.end_date,
          include_group_children: true,
          include_split_parents: true,
          limit,
          offset,
        },
      },
    });

    if (error) {
      throw new Error(`Lunch Money API error (${response.status}): ${describeError(error)}`);
    }

    all.push(...data.transactions);
    if (!data.has_more) break;
    offset += limit;
  }

  if (all.length >= maxPages * limit) {
    throw new Error(
      `Lunch Money pagination exceeded ${maxPages} pages (${all.length} transactions). This likely indicates an unexpectedly large dataset.`,
    );
  }

  return all;
}

export async function getManualAccounts(apiKey: string): Promise<LmManualAccount[]> {
  const client = createLunchMoneyClient(apiKey);
  const { data, error, response } = await client.GET("/manual_accounts");

  if (error) {
    throw new Error(`Lunch Money API error (${response.status}): ${describeError(error)}`);
  }

  return data.manual_accounts ?? [];
}

export async function getUser(apiKey: string): Promise<LmUser> {
  const client = createLunchMoneyClient(apiKey);
  const { data, error, response } = await client.GET("/me");

  if (error) {
    throw new Error(`Lunch Money API error (${response.status}): ${describeError(error)}`);
  }

  return data;
}

export async function getCategories(apiKey: string): Promise<LmCategory[]> {
  const client = createLunchMoneyClient(apiKey);
  const { data, error, response } = await client.GET("/categories", {
    params: { query: { format: "flattened" } },
  });

  if (error) {
    throw new Error(`Lunch Money API error (${response.status}): ${describeError(error)}`);
  }

  return data.categories ?? [];
}

export async function updateAccountBalance(
  apiKey: string,
  accountId: number,
  balance: number,
): Promise<void> {
  const client = createLunchMoneyClient(apiKey);
  const { error, response } = await client.PUT("/manual_accounts/{id}", {
    params: { path: { id: accountId } },
    body: {
      balance,
      balance_as_of: new Date().toISOString(),
    },
  });

  if (error) {
    throw new Error(
      `Lunch Money update balance error (${response.status}): ${describeError(error)}`,
    );
  }
}
