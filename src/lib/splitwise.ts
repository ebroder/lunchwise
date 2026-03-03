import createClient from "openapi-fetch";
import type { paths, components } from "./splitwise-api.js";

export type SplitwiseExpense = components["schemas"]["expense"];
export type SplitwiseShare = components["schemas"]["share"];

export function createSplitwiseClient(accessToken: string) {
  return createClient<paths>({
    baseUrl: "https://secure.splitwise.com/api/v3.0",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function getAllExpenses(
  accessToken: string,
  params: {
    group_id?: number;
    updated_after?: string;
  },
): Promise<SplitwiseExpense[]> {
  const client = createSplitwiseClient(accessToken);
  const pageSize = 100;
  const allExpenses: SplitwiseExpense[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await client.GET("/get_expenses", {
      params: {
        query: {
          group_id: params.group_id,
          updated_after: params.updated_after,
          limit: pageSize,
          offset,
        },
      },
    });

    if (error) {
      throw new Error(`Splitwise API error: ${JSON.stringify(error)}`);
    }

    const expenses = data?.expenses ?? [];
    allExpenses.push(...expenses);

    if (expenses.length < pageSize) break;
    offset += pageSize;

    // Small delay between pages to be respectful
    await new Promise((r) => setTimeout(r, 200));
  }

  return allExpenses;
}

export function getUserShare(
  expense: SplitwiseExpense,
  splitwiseUserId: string,
): number | null {
  const userEntry = expense.users?.find(
    (u) => String(u.user_id) === splitwiseUserId,
  );
  if (!userEntry?.net_balance) return null;

  const netBalance = parseFloat(userEntry.net_balance);
  if (netBalance === 0) return null;

  // net_balance > 0 means user paid more than owed (they're owed money, so it's income/credit)
  // net_balance < 0 means user owes (it's an expense)
  // Flip sign: positive = expense in Lunch Money
  return -netBalance;
}
