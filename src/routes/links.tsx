import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { requireAuth, type AuthEnv } from "../lib/auth.js";
import { links as linksTable, syncLog } from "../lib/schema-user.js";
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
          <button
            type="button"
            id="dry-run-btn"
            class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Dry run
          </button>
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

      <div id="dry-run-results" class="mt-8 hidden" data-link-id={String(linkId)}></div>

      <script type="module" src="/dry-run.js"></script>
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

export { links };
