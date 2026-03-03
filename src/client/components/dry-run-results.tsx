import { Button, card, alertError } from "./ui.js";

interface DryRunAction {
  type: "create" | "update" | "delete";
  date: string;
  payee: string;
  amount: number;
  currency: string;
  expenseId: string;
}

interface BalancePreview {
  would_sync: boolean;
  balance: number | null;
  currency: string | null;
  balances_by_currency?: { currency: string; amount: number }[];
}

export interface DryRunResult {
  expenses_fetched: number;
  created: number;
  updated: number;
  deleted: number;
  actions: DryRunAction[];
  balance: BalancePreview;
}

function badgeClass(type: string) {
  if (type === "create")
    return "text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-800";
  if (type === "update")
    return "text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800";
  return "text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-800";
}

function formatAmount(amount: number, currency: string) {
  const abs = Math.abs(amount).toFixed(2);
  if (amount < 0) return `-${currency} ${abs} (credit)`;
  return `${currency} ${abs}`;
}

interface DryRunResultsProps {
  state: "idle" | "loading" | "done" | "error";
  data: DryRunResult | null;
  error: string | null;
  syncing: boolean;
  onSync: () => void;
}

export function DryRunResults({ state, data, error, syncing, onSync }: DryRunResultsProps) {
  if (state === "loading") {
    return (
      <div class="mt-8">
        <p class="text-sm text-stone-500 dark:text-stone-400">Loading dry run...</p>
      </div>
    );
  }

  if (state === "error") {
    return <div class={`mt-8 ${alertError}`}>{error}</div>;
  }

  if (state !== "done" || !data) return null;

  return (
    <div class="mt-8">
      <h2 class="text-lg font-semibold mb-1">Dry Run Results</h2>
      <p class="text-sm text-stone-500 dark:text-stone-400 mb-4">
        No changes were made. This shows what a sync would do.
      </p>

      <div class={`${card} p-4 mb-4`}>
        <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            Expenses fetched: <span class="font-medium">{data.expenses_fetched}</span>
          </span>
          <span>
            Would create:{" "}
            <span class="font-medium text-green-700 dark:text-green-400">{data.created}</span>
          </span>
          <span>
            Would update:{" "}
            <span class="font-medium text-blue-700 dark:text-blue-400">{data.updated}</span>
          </span>
          <span>
            Would delete:{" "}
            <span class="font-medium text-red-700 dark:text-red-400">{data.deleted}</span>
          </span>
        </div>
      </div>

      {data.balance?.would_sync && (
        <div class={`${card} p-4 mb-4`}>
          <h3 class="text-sm font-medium text-stone-700 dark:text-stone-300 mb-2">
            Balance Sync Preview
          </h3>
          <p class="text-sm text-stone-600 dark:text-stone-400">
            Would set account balance to{" "}
            <span class="font-medium text-stone-900 dark:text-stone-100">
              {data.balance.currency} {data.balance.balance?.toFixed(2)}
            </span>
          </p>
          {data.balance.balances_by_currency &&
            new Set(data.balance.balances_by_currency.map((b) => b.currency)).size > 1 && (
              <p class="text-xs text-stone-500 dark:text-stone-400 mt-1">
                Converted from:{" "}
                {data.balance.balances_by_currency
                  .map((b) => `${b.currency} ${b.amount.toFixed(2)}`)
                  .join(", ")}
              </p>
            )}
        </div>
      )}

      {data.actions.length === 0 ? (
        <p class="text-sm text-stone-500 dark:text-stone-400">Nothing to sync.</p>
      ) : (
        <>
          <div class={`${card} overflow-hidden`}>
            <table class="w-full text-sm">
              <thead class="bg-stone-50 dark:bg-stone-800/50 border-b border-stone-200 dark:border-stone-800">
                <tr>
                  <th class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                    Action
                  </th>
                  <th class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                    Date
                  </th>
                  <th class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                    Payee
                  </th>
                  <th class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                    Your Share
                  </th>
                  <th class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                    Expense ID
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-stone-100 dark:divide-stone-800">
                {data.actions.map((a) => (
                  <tr key={a.expenseId}>
                    <td class="px-4 py-2">
                      <span
                        class={`inline-block px-2 py-0.5 rounded border text-xs font-medium ${badgeClass(a.type)}`}
                      >
                        {a.type}
                      </span>
                    </td>
                    <td class="px-4 py-2 text-stone-700 dark:text-stone-300">{a.date}</td>
                    <td class="px-4 py-2 text-stone-700 dark:text-stone-300 max-w-xs truncate">
                      {a.payee}
                    </td>
                    <td
                      class={`px-4 py-2 text-right tabular-nums ${
                        a.amount < 0
                          ? "text-green-700 dark:text-green-400"
                          : "text-stone-700 dark:text-stone-300"
                      }`}
                    >
                      {formatAmount(a.amount, a.currency)}
                    </td>
                    <td class="px-4 py-2 text-right text-stone-400 dark:text-stone-500 tabular-nums">
                      {a.expenseId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="mt-4">
            <Button type="button" onClick={onSync} disabled={syncing}>
              {syncing ? "Syncing..." : "Run Sync for Real"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
