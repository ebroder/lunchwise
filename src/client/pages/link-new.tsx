import { useState, useEffect } from "preact/hooks";
import { useLocation, Link } from "wouter";
import { api, apiJson, ApiError } from "../lib/api.js";

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

const card =
  "bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800";
const input =
  "w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 dark:focus:ring-stone-400 focus:border-transparent";
const label = "block text-sm font-medium text-stone-700 dark:text-stone-300 mb-1";
const btn =
  "bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-6 py-2 rounded-lg text-sm font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors disabled:opacity-50";

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
        setError(
          err instanceof ApiError ? err.message : "Failed to load form data",
        );
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
      });
      navigate(`/dashboard/links/${result.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to create link",
      );
      setSaving(false);
    }
  }

  return (
    <div>
      <div class="mb-6">
        <Link
          href="/dashboard"
          class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
        >
          &larr; Back to dashboard
        </Link>
      </div>

      <h1 class="text-2xl font-bold mb-6">New Sync Link</h1>

      {error && (
        <div class="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 mb-6 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <p class="text-sm text-stone-500 dark:text-stone-400">Loading...</p>
      ) : (
        <form onSubmit={handleSubmit} class={`${card} p-6 space-y-5`}>
          <div>
            <label class={label}>Splitwise Group</label>
            <select
              class={input}
              value={groupId}
              onChange={(e) =>
                setGroupId((e.target as HTMLSelectElement).value)
              }
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
            <label class={label}>Lunch Money Account</label>
            <select
              class={input}
              required
              value={accountId}
              onChange={(e) =>
                setAccountId((e.target as HTMLSelectElement).value)
              }
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
            <label class={label}>Start Date</label>
            <input
              type="date"
              class={input}
              value={startDate}
              onInput={(e) =>
                setStartDate((e.target as HTMLInputElement).value)
              }
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
              onChange={(e) =>
                setIncludePayments((e.target as HTMLInputElement).checked)
              }
              class="rounded border-stone-300 dark:border-stone-600"
            />
            <label
              for="include_payments"
              class="text-sm text-stone-700 dark:text-stone-300"
            >
              Include Splitwise payments (settlements between users)
            </label>
          </div>

          <button type="submit" disabled={saving} class={btn}>
            {saving ? "Creating..." : "Create Link"}
          </button>
        </form>
      )}
    </div>
  );
}
