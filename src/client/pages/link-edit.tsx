import { useState, useEffect } from "preact/hooks";
import { useLocation, useSearch, Link as WouterLink } from "wouter";
import { api, apiJson, ApiError } from "../lib/api.js";

interface SyncLink {
  id: number;
  splitwiseGroupId: string | null;
  lmAccountId: number;
  startDate: string | null;
  includePayments: number;
  syncBalance: number;
  enabled: number;
}

interface Group {
  id: number;
  name: string;
}

interface Account {
  id: number;
  name: string;
  display_name: string | null;
  currency: string;
}

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

interface DryRunResult {
  expenses_fetched: number;
  created: number;
  updated: number;
  deleted: number;
  actions: DryRunAction[];
  balance: BalancePreview;
}

const card =
  "bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800";
const input =
  "w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 dark:focus:ring-stone-400 focus:border-transparent";
const labelCls =
  "block text-sm font-medium text-stone-700 dark:text-stone-300 mb-1";
const btn =
  "bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-6 py-2 rounded-lg text-sm font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors disabled:opacity-50";

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

export function LinkEdit({ params }: { params: { id: string } }) {
  const linkId = params.id;
  const [, navigate] = useLocation();
  const search = useSearch();

  const [link, setLink] = useState<SyncLink | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Form state
  const [groupId, setGroupId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [includePayments, setIncludePayments] = useState(false);
  const [syncBalance, setSyncBalance] = useState(false);
  const [enabled, setEnabled] = useState(false);

  // Dry run state
  const [dryRunState, setDryRunState] = useState<
    "idle" | "loading" | "done" | "error"
  >("idle");
  const [dryRunData, setDryRunData] = useState<DryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  // Sync state
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    Promise.all([
      api<SyncLink>(`/api/links/${linkId}`),
      api<Group[]>("/api/splitwise/groups"),
      api<Account[]>("/api/lunch-money/accounts"),
    ])
      .then(([l, g, a]) => {
        setLink(l);
        setGroups(g);
        setAccounts(a);
        setGroupId(l.splitwiseGroupId ?? "");
        setAccountId(String(l.lmAccountId));
        setStartDate(l.startDate ?? "");
        setIncludePayments(l.includePayments === 1);
        setSyncBalance(l.syncBalance === 1);
        setEnabled(l.enabled === 1);
      })
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.message : "Failed to load link",
        );
      })
      .finally(() => setLoading(false));
  }, [linkId]);

  // Auto-run dry run if ?dry-run is in the URL
  useEffect(() => {
    if (search.includes("dry-run") && !loading && link) {
      runDryRun();
    }
  }, [loading, link]);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSaving(true);
    setAlert(null);
    try {
      await apiJson(
        `/api/links/${linkId}`,
        {
          splitwiseGroupId: groupId || null,
          lmAccountId: parseInt(accountId, 10),
          startDate: startDate || null,
          includePayments,
          syncBalance,
          enabled,
        },
        "PUT",
      );
      setAlert({ type: "success", message: "Changes saved." });
    } catch (err) {
      setAlert({
        type: "error",
        message:
          err instanceof ApiError ? err.message : "Failed to save changes",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this link? Sync history will also be removed.")) {
      return;
    }
    try {
      await api(`/api/links/${linkId}`, { method: "DELETE" });
      navigate("/dashboard");
    } catch (err) {
      setAlert({
        type: "error",
        message:
          err instanceof ApiError ? err.message : "Failed to delete link",
      });
    }
  }

  async function runDryRun() {
    setDryRunState("loading");
    setDryRunError(null);
    try {
      const result = await api<DryRunResult>(`/api/links/${linkId}/dry-run`);
      setDryRunData(result);
      setDryRunState("done");
    } catch (err) {
      setDryRunError(
        err instanceof ApiError ? err.message : "Dry run failed",
      );
      setDryRunState("error");
    }
  }

  async function runSync() {
    setSyncing(true);
    setAlert(null);
    try {
      const result = await apiJson<{
        created: number;
        updated: number;
        deleted: number;
      }>(`/api/sync/${linkId}`, {});
      setAlert({
        type: "success",
        message: `Sync complete: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted.`,
      });
      setDryRunState("idle");
    } catch (err) {
      setAlert({
        type: "error",
        message: err instanceof ApiError ? err.message : "Sync failed",
      });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div class="mb-6">
        <WouterLink
          href="/dashboard"
          class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
        >
          &larr; Back to dashboard
        </WouterLink>
      </div>

      <h1 class="text-2xl font-bold mb-6">Edit Sync Link</h1>

      {loading ? (
        <p class="text-sm text-stone-500 dark:text-stone-400">Loading...</p>
      ) : error ? (
        <div class="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      ) : (<>

      {alert && (
        <div
          class={
            alert.type === "success"
              ? "bg-green-50 dark:bg-green-950/50 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 rounded-lg px-4 py-3 mb-6 text-sm"
              : "bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 mb-6 text-sm"
          }
        >
          {alert.message}
        </div>
      )}

      <form onSubmit={handleSubmit} class={`${card} p-6 space-y-5`}>
        <div>
          <label class={labelCls}>Splitwise Group</label>
          <select
            class={input}
            value={groupId}
            onChange={(e) => setGroupId((e.target as HTMLSelectElement).value)}
          >
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.id} value={String(g.id)}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label class={labelCls}>Lunch Money Account</label>
          <select
            class={input}
            required
            value={accountId}
            onChange={(e) =>
              setAccountId((e.target as HTMLSelectElement).value)
            }
          >
            {accounts.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.display_name ?? a.name} ({a.currency})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label class={labelCls}>Start Date</label>
          <input
            type="date"
            class={input}
            value={startDate}
            onInput={(e) =>
              setStartDate((e.target as HTMLInputElement).value)
            }
          />
        </div>

        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            id="include_payments"
            checked={includePayments}
            onChange={(e) =>
              setIncludePayments((e.target as HTMLInputElement).checked)
            }
            class="rounded border-stone-300 dark:border-stone-600"
          />
          <label
            for="include_payments"
            class="text-sm text-stone-700 dark:text-stone-300"
          >
            Include Splitwise payments
          </label>
        </div>

        <div>
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id="sync_balance"
              checked={syncBalance}
              onChange={(e) =>
                setSyncBalance((e.target as HTMLInputElement).checked)
              }
              class="rounded border-stone-300 dark:border-stone-600"
            />
            <label
              for="sync_balance"
              class="text-sm text-stone-700 dark:text-stone-300"
            >
              Sync account balance
            </label>
          </div>
          <p class="text-xs text-stone-500 dark:text-stone-400 mt-1 ml-5">
            Overwrite the Lunch Money account balance with your Splitwise balance.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            id="enabled"
            checked={enabled}
            onChange={(e) =>
              setEnabled((e.target as HTMLInputElement).checked)
            }
            class="rounded border-stone-300 dark:border-stone-600"
          />
          <label
            for="enabled"
            class="text-sm text-stone-700 dark:text-stone-300"
          >
            Enabled
          </label>
        </div>

        <div class="flex gap-3">
          <button type="submit" disabled={saving} class={btn}>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>

      <div class="mt-6 pt-6 border-t border-stone-200 dark:border-stone-800 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <button
            type="button"
            onClick={runDryRun}
            disabled={dryRunState === "loading"}
            class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
          >
            {dryRunState === "loading" ? "Running..." : "Dry run"}
          </button>
          <WouterLink
            href={`/dashboard/links/${linkId}/history`}
            class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Sync history
          </WouterLink>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          class="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
        >
          Delete this link
        </button>
      </div>

      {/* Dry run results */}
      {dryRunState === "loading" && (
        <div class="mt-8">
          <p class="text-sm text-stone-500 dark:text-stone-400">
            Loading dry run...
          </p>
        </div>
      )}

      {dryRunState === "error" && (
        <div class="mt-8 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 text-sm">
          {dryRunError}
        </div>
      )}

      {dryRunState === "done" && dryRunData && (
        <div class="mt-8">
          <h2 class="text-lg font-semibold mb-1">Dry Run Results</h2>
          <p class="text-sm text-stone-500 dark:text-stone-400 mb-4">
            No changes were made. This shows what a sync would do.
          </p>

          <div class={`${card} p-4 mb-4`}>
            <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                Expenses fetched:{" "}
                <span class="font-medium">
                  {dryRunData.expenses_fetched}
                </span>
              </span>
              <span>
                Would create:{" "}
                <span class="font-medium text-green-700 dark:text-green-400">
                  {dryRunData.created}
                </span>
              </span>
              <span>
                Would update:{" "}
                <span class="font-medium text-blue-700 dark:text-blue-400">
                  {dryRunData.updated}
                </span>
              </span>
              <span>
                Would delete:{" "}
                <span class="font-medium text-red-700 dark:text-red-400">
                  {dryRunData.deleted}
                </span>
              </span>
            </div>
          </div>

          {dryRunData.balance?.would_sync && (
            <div class={`${card} p-4 mb-4`}>
              <h3 class="text-sm font-medium text-stone-700 dark:text-stone-300 mb-2">
                Balance Sync Preview
              </h3>
              <p class="text-sm text-stone-600 dark:text-stone-400">
                Would set account balance to{" "}
                <span class="font-medium text-stone-900 dark:text-stone-100">
                  {dryRunData.balance.currency}{" "}
                  {dryRunData.balance.balance?.toFixed(2)}
                </span>
              </p>
              {dryRunData.balance.balances_by_currency &&
                new Set(dryRunData.balance.balances_by_currency.map((b) => b.currency)).size > 1 && (
                <p class="text-xs text-stone-500 dark:text-stone-400 mt-1">
                  Converted from:{" "}
                  {dryRunData.balance.balances_by_currency
                    .map((b) => `${b.currency} ${b.amount.toFixed(2)}`)
                    .join(", ")}
                </p>
              )}
            </div>
          )}

          {dryRunData.actions.length === 0 ? (
            <p class="text-sm text-stone-500 dark:text-stone-400">
              Nothing to sync.
            </p>
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
                    {dryRunData.actions.map((a, i) => (
                      <tr key={i}>
                        <td class="px-4 py-2">
                          <span
                            class={`inline-block px-2 py-0.5 rounded border text-xs font-medium ${badgeClass(a.type)}`}
                          >
                            {a.type}
                          </span>
                        </td>
                        <td class="px-4 py-2 text-stone-700 dark:text-stone-300">
                          {a.date}
                        </td>
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
                <button
                  type="button"
                  onClick={runSync}
                  disabled={syncing}
                  class={btn}
                >
                  {syncing ? "Syncing..." : "Run Sync for Real"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      </>)}
    </div>
  );
}
