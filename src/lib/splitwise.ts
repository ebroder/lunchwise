import createClient from "openapi-fetch";
import type { paths, components } from "./splitwise-api.js";
import { apiError } from "./errors.js";
import { countedFetch } from "./request-budget.js";

export type SplitwiseExpense = components["schemas"]["expense"];
export type SplitwiseShare = components["schemas"]["share"];
export type SplitwiseGroup = components["schemas"]["group"];

export function createSplitwiseClient(accessToken: string) {
  return createClient<paths>({
    baseUrl: "https://secure.splitwise.com/api/v3.0",
    fetch: countedFetch,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export const EXPENSE_PAGE_SIZE = 1000;

// Up to `maxPages` pages of the listing, starting at `offset`. `nextOffset` is where the next
// page starts, or null once a page comes back short.
export async function getExpenses(
  accessToken: string,
  params: {
    group_id?: number;
    updated_after?: string;
    offset?: number;
    maxPages: number;
  },
): Promise<{ expenses: SplitwiseExpense[]; nextOffset: number | null }> {
  const client = createSplitwiseClient(accessToken);
  const expenses: SplitwiseExpense[] = [];
  let offset = params.offset ?? 0;

  for (let page = 0; page < params.maxPages; page++) {
    if (page > 0) {
      // Small delay between pages to be respectful
      await new Promise<void>((r) => {
        setTimeout(r, 200);
      });
    }

    const { data, error, response } = await client.GET("/get_expenses", {
      params: {
        query: {
          group_id: params.group_id,
          updated_after: params.updated_after,
          limit: EXPENSE_PAGE_SIZE,
          offset,
        },
      },
    });

    if (error) {
      throw apiError("Splitwise", response.status, error);
    }

    const pageExpenses = data?.expenses ?? [];
    expenses.push(...pageExpenses);
    if (pageExpenses.length < EXPENSE_PAGE_SIZE) return { expenses, nextOffset: null };
    offset += EXPENSE_PAGE_SIZE;
  }

  return { expenses, nextOffset: offset };
}

export async function getGroups(accessToken: string): Promise<SplitwiseGroup[]> {
  const client = createSplitwiseClient(accessToken);
  const { data, error, response } = await client.GET("/get_groups");

  if (error) {
    throw apiError("Splitwise", response.status, error);
  }

  return data?.groups ?? [];
}

export async function getGroup(
  accessToken: string,
  groupId: number,
): Promise<SplitwiseGroup | null> {
  const client = createSplitwiseClient(accessToken);
  const { data, error, response } = await client.GET("/get_group/{id}", {
    params: { path: { id: groupId } },
  });

  if (error) {
    throw apiError("Splitwise", response.status, error);
  }

  return data?.group ?? null;
}

export interface CurrencyBalance {
  currency: string;
  amount: number;
}

// Extract the current user's balances from a group's member list.
// Returns one entry per currency the user has a non-zero balance in.
export function getUserBalances(group: SplitwiseGroup, splitwiseUserId: string): CurrencyBalance[] {
  const member = group.members?.find((m) => String(m.id) === splitwiseUserId);
  if (!member?.balance) return [];

  const balances: CurrencyBalance[] = [];
  for (const b of member.balance) {
    if (!b.currency_code || !b.amount) continue;
    const amount = parseFloat(b.amount);
    if (amount === 0) continue;
    balances.push({ currency: b.currency_code, amount });
  }
  return balances;
}

export function getUserShare(expense: SplitwiseExpense, splitwiseUserId: string): number | null {
  const userEntry = expense.users?.find((u) => String(u.user_id) === splitwiseUserId);
  if (!userEntry?.net_balance) return null;

  const netBalance = parseFloat(userEntry.net_balance);
  if (netBalance === 0) return null;

  // net_balance > 0 means user paid more than owed (they're owed money, so it's income/credit)
  // net_balance < 0 means user owes (it's an expense)
  // Flip sign: positive = debit in Lunch Money
  return -netBalance;
}
