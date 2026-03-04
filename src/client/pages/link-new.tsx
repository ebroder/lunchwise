import { useState, useEffect } from "preact/hooks";
import { useLocation, Link } from "wouter";
import { api, apiJson, ApiError } from "../lib/api.js";
import { Button, card, inputClass, labelClass, alertError } from "../components/ui.js";

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

export function LinkNew() {
  const [, navigate] = useLocation();
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [groupId, setGroupId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [includePayments, setIncludePayments] = useState(false);
  const [syncBalance, setSyncBalance] = useState(false);

  useEffect(() => {
    Promise.all([
      api<Group[]>("/api/splitwise/groups"),
      api<Account[]>("/api/lunch-money/accounts"),
    ])
      .then(([g, a]) => {
        setGroups(g);
        setAccounts(a);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to load form data");
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await apiJson<{ id: number }>("/api/links", {
        splitwiseGroupId: groupId || null,
        lmAccountId: parseInt(accountId, 10),
        startDate: startDate || null,
        includePayments,
        syncBalance,
      });
      navigate(`/dashboard/links/${result.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create link");
      setSaving(false);
    }
  }

  return (
    <div>
      <div class="mb-6">
        <Link
          href="/dashboard"
          class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
        >
          &larr; Back to dashboard
        </Link>
      </div>

      <h1 class="text-2xl font-bold mb-6">New Sync Link</h1>

      {error && <div class={alertError}>{error}</div>}

      {loading ? (
        <p class="text-sm text-stone-500 dark:text-stone-400">Loading...</p>
      ) : (
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
              <option value="">Select an account...</option>
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
            <p class="text-xs text-stone-500 dark:text-stone-400 mt-1">
              Only sync expenses on or after this date. Leave blank to sync all.
            </p>
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
              Include Splitwise payments (settlements between users)
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

          <Button type="submit" disabled={saving}>
            {saving ? "Creating..." : "Create Link"}
          </Button>
        </form>
      )}
    </div>
  );
}
