import { Hono } from "hono";
import { desc } from "drizzle-orm";
import { requireAuth, type AuthEnv } from "../lib/auth.js";
import { links } from "../lib/schema-user.js";

const dashboard = new Hono<AuthEnv>();

dashboard.use("*", requireAuth);

dashboard.get("/", async (c) => {
  const user = c.get("user");
  const hasLunchMoney = !!user.lunchMoneyApiKey;
  const error = c.req.query("error");
  const synced = c.req.query("synced");
  const syncError = c.req.query("sync_error");

  const db = c.get("db");
  const userLinks = await db
    .select()
    .from(links)
    .orderBy(desc(links.createdAt));

  return c.render(
    <div>
      <div class="flex items-center justify-between mb-8">
        <h1 class="text-2xl font-bold">Dashboard</h1>
        <a
          href="/auth/logout"
          class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
        >
          Log out
        </a>
      </div>

      {synced && (
        <div class="bg-green-50 dark:bg-green-950/50 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 rounded-lg px-4 py-3 mb-6 text-sm">
          Sync complete: {c.req.query("created")} created, {c.req.query("updated")} updated, {c.req.query("deleted")} deleted.
        </div>
      )}
      {syncError && (
        <div class="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 mb-6 text-sm">
          Sync failed: {c.req.query("message")}
        </div>
      )}

      {error === "invalid_key" && (
        <div class="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 mb-6 text-sm">
          That API key is invalid. Please check it and try again.
        </div>
      )}
      {error === "missing_key" && (
        <div class="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 mb-6 text-sm">
          Please enter an API key.
        </div>
      )}

      <div class="space-y-6">
        {/* Connection status */}
        <div class="bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800 p-6">
          <h2 class="text-lg font-semibold mb-4">Connections</h2>
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <span>Splitwise</span>
              <span class="text-sm text-green-600 dark:text-green-400 font-medium">Connected</span>
            </div>
            <div class="flex items-center justify-between">
              <span>Lunch Money</span>
              {hasLunchMoney ? (
                <span class="text-sm text-green-600 dark:text-green-400 font-medium">
                  Connected
                </span>
              ) : (
                <span class="text-sm text-amber-600 dark:text-amber-400 font-medium">
                  Not connected
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Lunch Money API key form */}
        {!hasLunchMoney && (
          <div class="bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800 p-6">
            <h2 class="text-lg font-semibold mb-2">Connect Lunch Money</h2>
            <p class="text-sm text-stone-600 dark:text-stone-400 mb-4">
              Enter your API key from{" "}
              <a
                href="https://my.lunchmoney.app/developers"
                target="_blank"
                class="text-blue-600 dark:text-blue-400 underline"
              >
                Lunch Money settings
              </a>
              .
            </p>
            <form method="post" action="/api/settings/lunch-money" class="flex gap-3">
              <input
                type="text"
                name="api_key"
                placeholder="Your Lunch Money API key"
                required
                class="flex-1 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 dark:focus:ring-stone-400 focus:border-transparent"
              />
              <button
                type="submit"
                class="bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-4 py-2 rounded-lg text-sm font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors"
              >
                Save
              </button>
            </form>
          </div>
        )}

        {/* Links */}
        {hasLunchMoney && (
          <div class="bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800 p-6">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-lg font-semibold">Sync Links</h2>
              <a
                href="/dashboard/links/new"
                class="bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-4 py-2 rounded-lg text-sm font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors"
              >
                New Link
              </a>
            </div>

            {userLinks.length === 0 ? (
              <p class="text-sm text-stone-500 dark:text-stone-400">No links configured yet.</p>
            ) : (
              <div class="divide-y divide-stone-100 dark:divide-stone-800">
                {userLinks.map((link) => (
                  <div class="py-3 flex items-center justify-between">
                    <div>
                      <div class="text-sm font-medium">
                        {link.splitwiseGroupId
                          ? `Group #${link.splitwiseGroupId}`
                          : "All groups"}
                        {" → "}
                        Account #{link.lmAccountId}
                      </div>
                      <div class="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                        {link.lastSyncedAt
                          ? `Last synced: ${link.lastSyncedAt}`
                          : "Never synced"}
                        {!link.enabled && (
                          <span class="ml-2 text-amber-600 dark:text-amber-400">(disabled)</span>
                        )}
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <form method="post" action={`/dashboard/links/${link.id}/dry-run`}>
                        <button
                          type="submit"
                          class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 px-3 py-1 rounded border border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500 transition-colors"
                        >
                          Dry Run
                        </button>
                      </form>
                      <form method="post" action={`/api/sync/${link.id}`}>
                        <button
                          type="submit"
                          class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 px-3 py-1 rounded border border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500 transition-colors"
                        >
                          Sync Now
                        </button>
                      </form>
                      <a
                        href={`/dashboard/links/${link.id}/history`}
                        class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
                      >
                        History
                      </a>
                      <a
                        href={`/dashboard/links/${link.id}`}
                        class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
                      >
                        Edit
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    { title: "Dashboard" },
  );
});

export { dashboard };
