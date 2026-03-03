import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { requireAuth, type AuthEnv } from "../lib/auth.js";
import { links as linksTable, syncLog } from "../lib/schema-user.js";
import { syncLink, type PlannedAction } from "../lib/sync.js";
import { createSplitwiseClient } from "../lib/splitwise.js";
import { getManualAccounts } from "../lib/lunch-money.js";

const links = new Hono<AuthEnv>();

links.use("*", requireAuth);

// Shared classes
const card = "bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800";
const input = "w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 dark:focus:ring-stone-400 focus:border-transparent";
const btn = "bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-6 py-2 rounded-lg text-sm font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors";
const backLink = "text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200";
const label = "block text-sm font-medium text-stone-700 dark:text-stone-300 mb-1";
const muted = "text-sm text-stone-500 dark:text-stone-400";

links.get("/new", async (c) => {
  const user = c.get("user");
  if (!user.lunchMoneyApiKey) {
    return c.redirect("/dashboard");
  }

  const sw = createSplitwiseClient(user.splitwiseAccessToken);
  const [groupsResult, accounts] = await Promise.all([
    sw.GET("/get_groups"),
    getManualAccounts(user.lunchMoneyApiKey),
  ]);
  const groups = groupsResult.data?.groups ?? [];

  return c.render(
    <div>
      <div class="mb-6">
        <a href="/dashboard" class={backLink}>
          &larr; Back to dashboard
        </a>
      </div>

      <h1 class="text-2xl font-bold mb-6">New Sync Link</h1>

      <form
        method="post"
        action="/api/links"
        class={`${card} p-6 space-y-5`}
      >
        <div>
          <label class={label}>Splitwise Group</label>
          <select name="splitwise_group_id" class={input}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option value={String(g.id)}>{g.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label class={label}>Lunch Money Account</label>
          <select name="lm_account_id" required class={input}>
            <option value="">Select an account...</option>
            {accounts.map((a) => (
              <option value={String(a.id)}>
                {a.display_name ?? a.name} ({a.currency})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label class={label}>Start Date</label>
          <input type="date" name="start_date" class={input} />
          <p class="text-xs text-stone-500 dark:text-stone-400 mt-1">
            Only sync expenses on or after this date. Leave blank to sync all.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            name="include_payments"
            id="include_payments"
            class="rounded border-stone-300 dark:border-stone-600"
          />
          <label for="include_payments" class="text-sm text-stone-700 dark:text-stone-300">
            Include Splitwise payments (settlements between users)
          </label>
        </div>

        <button type="submit" class={btn}>
          Create Link
        </button>
      </form>
    </div>,
    { title: "New Link" },
  );
});

links.get("/:id", async (c) => {
  const user = c.get("user");
  const linkId = parseInt(c.req.param("id"), 10);

  if (!user.lunchMoneyApiKey) {
    return c.redirect("/dashboard");
  }

  const db = c.get("db");
  const rows = await db
    .select()
    .from(linksTable)
    .where(eq(linksTable.id, linkId));
  const link = rows[0];
  if (!link) {
    return c.redirect("/dashboard");
  }

  const sw = createSplitwiseClient(user.splitwiseAccessToken);
  const [groupsResult, accounts] = await Promise.all([
    sw.GET("/get_groups"),
    getManualAccounts(user.lunchMoneyApiKey),
  ]);
  const groups = groupsResult.data?.groups ?? [];

  return c.render(
    <div>
      <div class="mb-6">
        <a href="/dashboard" class={backLink}>
          &larr; Back to dashboard
        </a>
      </div>

      <h1 class="text-2xl font-bold mb-6">Edit Sync Link</h1>

      <form
        method="post"
        action={`/api/links/${linkId}`}
        class={`${card} p-6 space-y-5`}
      >
        <div>
          <label class={label}>Splitwise Group</label>
          <select name="splitwise_group_id" class={input}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option
                value={String(g.id)}
                selected={String(g.id) === link.splitwiseGroupId}
              >
                {g.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label class={label}>Lunch Money Account</label>
          <select name="lm_account_id" required class={input}>
            {accounts.map((a) => (
              <option
                value={String(a.id)}
                selected={a.id === link.lmAccountId}
              >
                {a.display_name ?? a.name} ({a.currency})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label class={label}>Start Date</label>
          <input
            type="date"
            name="start_date"
            value={link.startDate ?? ""}
            class={input}
          />
        </div>

        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            name="include_payments"
            id="include_payments"
            checked={link.includePayments === 1}
            class="rounded border-stone-300 dark:border-stone-600"
          />
          <label for="include_payments" class="text-sm text-stone-700 dark:text-stone-300">
            Include Splitwise payments
          </label>
        </div>

        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            id="enabled"
            checked={link.enabled === 1}
            class="rounded border-stone-300 dark:border-stone-600"
          />
          <label for="enabled" class="text-sm text-stone-700 dark:text-stone-300">
            Enabled
          </label>
        </div>

        <div class="flex gap-3">
          <button type="submit" class={btn}>
            Save Changes
          </button>
        </div>
      </form>

      <div class="mt-6 pt-6 border-t border-stone-200 dark:border-stone-800 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <form method="post" action={`/dashboard/links/${linkId}/dry-run`}>
            <button
              type="submit"
              class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
            >
              Dry run
            </button>
          </form>
          <a
            href={`/dashboard/links/${linkId}/history`}
            class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Sync history
          </a>
        </div>
        <form method="post" action={`/api/links/${linkId}`}>
          <input type="hidden" name="_method" value="DELETE" />
          <button
            type="submit"
            class="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
            onclick="return confirm('Delete this link? Sync history will also be removed.')"
          >
            Delete this link
          </button>
        </form>
      </div>
    </div>,
    { title: "Edit Link" },
  );
});

links.get("/:id/history", async (c) => {
  const linkId = parseInt(c.req.param("id"), 10);
  const db = c.get("db");

  const linkRows = await db
    .select()
    .from(linksTable)
    .where(eq(linksTable.id, linkId));
  if (linkRows.length === 0) {
    return c.redirect("/dashboard");
  }

  const logs = await db
    .select()
    .from(syncLog)
    .where(eq(syncLog.linkId, linkId))
    .orderBy(desc(syncLog.startedAt))
    .limit(50);

  return c.render(
    <div>
      <div class="mb-6">
        <a
          href={`/dashboard/links/${linkId}`}
          class={backLink}
        >
          &larr; Back to link
        </a>
      </div>

      <h1 class="text-2xl font-bold mb-6">Sync History</h1>

      {logs.length === 0 ? (
        <p class={muted}>No sync runs yet.</p>
      ) : (
        <div class={`${card} overflow-hidden`}>
          <table class="w-full text-sm">
            <thead class="bg-stone-50 dark:bg-stone-800/50 border-b border-stone-200 dark:border-stone-800">
              <tr>
                <th class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                  Started
                </th>
                <th class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                  Status
                </th>
                <th class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                  Fetched
                </th>
                <th class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                  Created
                </th>
                <th class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                  Updated
                </th>
                <th class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400">
                  Deleted
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-100 dark:divide-stone-800">
              {logs.map((log) => (
                <tr>
                  <td class="px-4 py-2 text-stone-700 dark:text-stone-300">
                    {log.startedAt}
                  </td>
                  <td class="px-4 py-2">
                    <span
                      class={
                        log.status === "success"
                          ? "text-green-600 dark:text-green-400"
                          : log.status === "error"
                            ? "text-red-600 dark:text-red-400"
                            : "text-amber-600 dark:text-amber-400"
                      }
                    >
                      {log.status}
                    </span>
                    {log.errorMessage && (
                      <span class="block text-xs text-red-500 dark:text-red-400 mt-0.5 max-w-xs truncate">
                        {log.errorMessage}
                      </span>
                    )}
                  </td>
                  <td class="px-4 py-2 text-right text-stone-600 dark:text-stone-400">
                    {log.expensesFetched}
                  </td>
                  <td class="px-4 py-2 text-right text-stone-600 dark:text-stone-400">
                    {log.created}
                  </td>
                  <td class="px-4 py-2 text-right text-stone-600 dark:text-stone-400">
                    {log.updated}
                  </td>
                  <td class="px-4 py-2 text-right text-stone-600 dark:text-stone-400">
                    {log.deleted}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>,
    { title: "Sync History" },
  );
});

function formatAmount(amount: number, currency: string): string {
  const abs = Math.abs(amount).toFixed(2);
  const sign = amount < 0 ? "-" : "";
  return `${sign}${currency} ${abs}`;
}

function actionBadge(type: PlannedAction["type"]): string {
  if (type === "create") return "text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-800";
  if (type === "update") return "text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800";
  return "text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-800";
}

links.post("/:id/dry-run", async (c) => {
  const user = c.get("user");
  const linkId = parseInt(c.req.param("id"), 10);
  const db = c.get("db");

  const rows = await db
    .select()
    .from(linksTable)
    .where(eq(linksTable.id, linkId));
  const link = rows[0];
  if (!link) {
    return c.redirect("/dashboard");
  }

  try {
    const result = await syncLink(db, link, user, { dryRun: true });
    const actions = result.actions ?? [];

    return c.render(
      <div>
        <div class="mb-6">
          <a
            href={`/dashboard/links/${linkId}`}
            class={backLink}
          >
            &larr; Back to link
          </a>
        </div>

        <h1 class="text-2xl font-bold mb-2">Dry Run Results</h1>
        <p class={`${muted} mb-6`}>
          No changes were made. This shows what a sync would do.
        </p>

        <div class={`${card} p-4 mb-6`}>
          <div class="flex gap-6 text-sm">
            <span>
              Expenses fetched: <span class="font-medium">{result.expenses_fetched}</span>
            </span>
            <span>
              Would create: <span class="font-medium text-green-700 dark:text-green-400">{result.created}</span>
            </span>
            <span>
              Would update: <span class="font-medium text-blue-700 dark:text-blue-400">{result.updated}</span>
            </span>
            <span>
              Would delete: <span class="font-medium text-red-700 dark:text-red-400">{result.deleted}</span>
            </span>
          </div>
        </div>

        {actions.length === 0 ? (
          <p class={muted}>Nothing to sync.</p>
        ) : (
          <div class={`${card} overflow-hidden`}>
            <table class="w-full text-sm">
              <thead class="bg-stone-50 dark:bg-stone-800/50 border-b border-stone-200 dark:border-stone-800">
                <tr>
                  <th class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Action</th>
                  <th class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Date</th>
                  <th class="text-left px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Payee</th>
                  <th class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Amount</th>
                  <th class="text-right px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Expense ID</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-stone-100 dark:divide-stone-800">
                {actions.map((action) => (
                  <tr>
                    <td class="px-4 py-2">
                      <span class={`inline-block px-2 py-0.5 rounded border text-xs font-medium ${actionBadge(action.type)}`}>
                        {action.type}
                      </span>
                    </td>
                    <td class="px-4 py-2 text-stone-700 dark:text-stone-300">{action.date}</td>
                    <td class="px-4 py-2 text-stone-700 dark:text-stone-300 max-w-xs truncate">{action.payee}</td>
                    <td class="px-4 py-2 text-right text-stone-700 dark:text-stone-300 tabular-nums">
                      {formatAmount(action.amount, action.currency)}
                    </td>
                    <td class="px-4 py-2 text-right text-stone-400 dark:text-stone-500 tabular-nums">{action.expenseId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {actions.length > 0 && (
          <div class="mt-6 flex gap-3">
            <form method="post" action={`/api/sync/${linkId}`}>
              <button type="submit" class={btn}>
                Run Sync for Real
              </button>
            </form>
            <a
              href="/dashboard"
              class="px-6 py-2 rounded-lg text-sm font-medium border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:border-stone-400 dark:hover:border-stone-500 transition-colors"
            >
              Cancel
            </a>
          </div>
        )}
      </div>,
      { title: "Dry Run" },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.render(
      <div>
        <div class="mb-6">
          <a href="/dashboard" class={backLink}>
            &larr; Back to dashboard
          </a>
        </div>
        <h1 class="text-2xl font-bold mb-4">Dry Run Failed</h1>
        <div class="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 text-sm">
          {message}
        </div>
      </div>,
      { title: "Dry Run Error" },
    );
  }
});

export { links };
