import { useState, useEffect, useCallback } from "preact/hooks";
import { useLocation, useSearch, Link as WouterLink } from "wouter";
import { api, apiJson, ApiError } from "../lib/api.js";
import { formatSyncResult } from "../lib/format.js";
import {
  Button,
  card,
  inputClass,
  labelClass,
  alertSuccess,
  alertError,
} from "../components/ui.js";
import { DryRunResults, type DryRunResult } from "../components/dry-run-results.js";

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
  const [dryRunState, setDryRunState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [dryRunData, setDryRunData] = useState<DryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  // Sync state
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<SyncLink>(`/api/links/${linkId}`, { signal: controller.signal }),
      api<Group[]>("/api/splitwise/groups", { signal: controller.signal }),
      api<Account[]>("/api/lunch-money/accounts", { signal: controller.signal }),
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
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : "Failed to load link");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [linkId]);

  const runDryRun = useCallback(async () => {
    setDryRunState("loading");
    setDryRunError(null);
    try {
      const result = await api<DryRunResult>(`/api/links/${linkId}/dry-run`);
      setDryRunData(result);
      setDryRunState("done");
    } catch (err) {
      setDryRunError(err instanceof ApiError ? err.message : "Dry run failed");
      setDryRunState("error");
    }
  }, [linkId]);

  // Auto-run dry run if ?dry-run is in the URL
  useEffect(() => {
    if (new URLSearchParams(search).has("dry-run") && !loading && link) {
      runDryRun();
    }
  }, [search, loading, link, runDryRun]);

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
        message: err instanceof ApiError ? err.message : "Failed to save changes",
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
        message: err instanceof ApiError ? err.message : "Failed to delete link",
      });
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
        message: formatSyncResult(result),
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
          class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
        >
          &larr; Back to dashboard
        </WouterLink>
      </div>

      <h1 class="text-2xl font-bold mb-6">Edit Sync Link</h1>

      {loading ? (
        <p class="text-sm text-stone-500 dark:text-stone-400">Loading...</p>
      ) : error ? (
        <div class={alertError}>{error}</div>
      ) : (
        <>
          {alert && (
            <div class={alert.type === "success" ? alertSuccess : alertError}>{alert.message}</div>
          )}

          <form onSubmit={handleSubmit} class={`${card} p-6 space-y-5`}>
            <div>
              <label class={labelClass}>Splitwise Group</label>
              <select
                class={inputClass}
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
              <label class={labelClass}>Lunch Money Account</label>
              <select
                class={inputClass}
                required
                value={accountId}
                onChange={(e) => setAccountId((e.target as HTMLSelectElement).value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.display_name ?? a.name} ({a.currency})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label class={labelClass}>Start Date</label>
              <input
                type="date"
                class={inputClass}
                value={startDate}
                onInput={(e) => setStartDate((e.target as HTMLInputElement).value)}
              />
            </div>

            <div class="flex items-center gap-2">
              <input
                type="checkbox"
                id="include_payments"
                checked={includePayments}
                onChange={(e) => setIncludePayments((e.target as HTMLInputElement).checked)}
                class="rounded border-stone-300 dark:border-stone-600"
              />
              <label for="include_payments" class="text-sm text-stone-700 dark:text-stone-300">
                Include Splitwise payments
              </label>
            </div>

            <div>
              <div class="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="sync_balance"
                  checked={syncBalance}
                  onChange={(e) => setSyncBalance((e.target as HTMLInputElement).checked)}
                  class="rounded border-stone-300 dark:border-stone-600"
                />
                <label for="sync_balance" class="text-sm text-stone-700 dark:text-stone-300">
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
                onChange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
                class="rounded border-stone-300 dark:border-stone-600"
              />
              <label for="enabled" class="text-sm text-stone-700 dark:text-stone-300">
                Enabled
              </label>
            </div>

            <div class="flex gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>

          <div class="mt-6 pt-6 border-t border-stone-200 dark:border-stone-800 flex items-center justify-between">
            <div class="flex items-center gap-4">
              <Button
                variant="ghost"
                type="button"
                onClick={runDryRun}
                disabled={dryRunState === "loading"}
              >
                {dryRunState === "loading" ? "Running..." : "Dry run"}
              </Button>
              <WouterLink
                href={`/dashboard/links/${linkId}/history`}
                class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
              >
                Sync history
              </WouterLink>
            </div>
            <Button variant="destructive" type="button" onClick={handleDelete}>
              Delete this link
            </Button>
          </div>

          <DryRunResults
            state={dryRunState}
            data={dryRunData}
            error={dryRunError}
            syncing={syncing}
            onSync={runSync}
          />
        </>
      )}
    </div>
  );
}
