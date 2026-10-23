import { useState, useEffect } from "preact/hooks";
import { Link } from "wouter";
import { api, apiJson, ApiError } from "../lib/api.js";
import { formatSyncResult, formatDateTime } from "../lib/format.js";
import { Button, card, inputClass, alertSuccess, alertError } from "../components/ui.js";

interface SyncLink {
  id: number;
  splitwiseGroupId: string | null;
  lmAccountId: number;
  syncBalance: number;
  enabled: number;
  lastSyncedAt: string | null;
  lastFailure: { at: string; message: string } | null;
  createdAt: string;
}

export function Dashboard() {
  const [lmConnected, setLmConnected] = useState<boolean | null>(null);
  const [lmKeyRejected, setLmKeyRejected] = useState(false);
  const [links, setLinks] = useState<SyncLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // after the first load, a failed refresh keeps what the page already shows
  function loadConnections() {
    api<{ hasLunchMoney: boolean; lunchMoneyKeyRejected: boolean }>("/api/me")
      .then((data) => {
        setLmConnected(data.hasLunchMoney);
        setLmKeyRejected(data.lunchMoneyKeyRejected);
      })
      .catch(() => setLmConnected((connected) => connected ?? false));
  }

  function loadLinks(firstLoad = false) {
    api<SyncLink[]>("/api/links")
      .then((data) => {
        setLinks(data);
        setFetchError(null);
      })
      .catch((err) => {
        if (firstLoad) {
          setFetchError(err instanceof ApiError ? err.message : "Failed to load links");
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadConnections();
    loadLinks(true);
  }, []);

  async function saveApiKey(e: Event) {
    e.preventDefault();
    setSavingKey(true);
    setAlert(null);
    try {
      await apiJson("/api/settings/lunch-money", { apiKey });
      setLmConnected(true);
      setLmKeyRejected(false);
      setApiKey("");
      loadLinks();
    } catch (err) {
      setAlert({
        type: "error",
        message: err instanceof ApiError ? err.message : "Failed to save API key",
      });
    } finally {
      setSavingKey(false);
    }
  }

  async function disconnectLm() {
    setAlert(null);
    try {
      await api("/api/settings/lunch-money", { method: "DELETE" });
      setLmConnected(false);
    } catch (err) {
      setAlert({
        type: "error",
        message: err instanceof ApiError ? err.message : "Failed to disconnect",
      });
    }
  }

  async function syncNow(linkId: number) {
    setSyncingId(linkId);
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
    } catch (err) {
      setAlert({
        type: "error",
        message: err instanceof ApiError ? err.message : "Sync failed",
      });
    } finally {
      setSyncingId(null);
    }
    loadConnections();
    loadLinks();
  }

  return (
    <div>
      <h1 class="text-2xl font-bold mb-8">Dashboard</h1>

      {alert && (
        <div class={alert.type === "success" ? alertSuccess : alertError}>{alert.message}</div>
      )}

      <div class="space-y-6">
        {/* Connection status */}
        <div class={`${card} p-6`}>
          <h2 class="text-lg font-semibold mb-4">Connections</h2>
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <span>Splitwise</span>
              <span class="text-sm text-green-600 dark:text-green-400 font-medium">Connected</span>
            </div>
            <div class="flex items-center justify-between">
              <span>Lunch Money</span>
              {lmConnected === null ? (
                <span class="text-sm text-stone-400 dark:text-stone-500">Checking...</span>
              ) : lmConnected ? (
                <div class="flex items-center gap-3">
                  {lmKeyRejected ? (
                    <span class="text-sm text-amber-600 dark:text-amber-400 font-medium">
                      Key rejected
                    </span>
                  ) : (
                    <span class="text-sm text-green-600 dark:text-green-400 font-medium">
                      Connected
                    </span>
                  )}
                  {links.length === 0 ? (
                    <button
                      type="button"
                      onClick={disconnectLm}
                      class="text-xs text-stone-400 dark:text-stone-500 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <span class="text-xs text-stone-400 dark:text-stone-500">
                      Remove all links to disconnect
                    </span>
                  )}
                </div>
              ) : (
                <span class="text-sm text-amber-600 dark:text-amber-400 font-medium">
                  Not connected
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Lunch Money API key form */}
        {(!lmConnected || lmKeyRejected) && (
          <div class={`${card} p-6`}>
            <h2 class="text-lg font-semibold mb-2">
              {lmKeyRejected ? "Replace your Lunch Money API key" : "Connect Lunch Money"}
            </h2>
            <p class="text-sm text-stone-600 dark:text-stone-400 mb-4">
              {lmKeyRejected
                ? "Lunch Money no longer accepts the API key Lunchwise has. Enter a new one from "
                : "Enter your API key from "}
              <a
                href="https://my.lunchmoney.app/developers"
                target="_blank"
                class="text-blue-600 dark:text-blue-400 underline"
              >
                Lunch Money settings
              </a>
              .
            </p>
            <form onSubmit={saveApiKey} class="flex gap-3">
              <input
                type="password"
                value={apiKey}
                onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
                placeholder="Your Lunch Money API key"
                required
                class={`flex-1 ${inputClass}`}
              />
              <Button type="submit" disabled={savingKey} class="px-4">
                {savingKey ? "Saving..." : "Save"}
              </Button>
            </form>
          </div>
        )}

        {/* Links */}
        {lmConnected && (
          <div class={`${card} p-6`}>
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-lg font-semibold">Sync Links</h2>
              <Link
                href="/dashboard/links/new"
                class="bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-4 py-2 rounded-lg text-sm font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors cursor-pointer"
              >
                New Link
              </Link>
            </div>

            {fetchError ? (
              <div class={alertError}>{fetchError}</div>
            ) : loading ? (
              <p class="text-sm text-stone-500 dark:text-stone-400">Loading...</p>
            ) : links.length === 0 ? (
              <p class="text-sm text-stone-500 dark:text-stone-400">No links configured yet.</p>
            ) : (
              <div class="divide-y divide-stone-100 dark:divide-stone-800">
                {links.map((link) => (
                  <div
                    key={link.id}
                    class="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  >
                    <div class="min-w-0">
                      <div class="text-sm font-medium">
                        {link.splitwiseGroupId ? `Group #${link.splitwiseGroupId}` : "All groups"}
                        {" \u2192 "}
                        Account #{link.lmAccountId}
                      </div>
                      <div class="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                        {link.lastSyncedAt
                          ? `Last synced: ${formatDateTime(link.lastSyncedAt)}`
                          : "Never synced"}
                        {!link.enabled && (
                          <span class="ml-2 text-amber-600 dark:text-amber-400">(disabled)</span>
                        )}
                        {!!link.syncBalance && (
                          <span class="ml-2 text-stone-400 dark:text-stone-500">
                            (balance sync)
                          </span>
                        )}
                      </div>
                      {link.lastFailure && (
                        <div class="text-xs text-red-600 dark:text-red-400 mt-0.5">
                          Last sync failed {formatDateTime(link.lastFailure.at)}.{" "}
                          {link.lastFailure.message}
                        </div>
                      )}
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Link
                        href={`/dashboard/links/${link.id}?dry-run`}
                        class="text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 px-3 py-1 rounded border border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500 transition-colors cursor-pointer"
                      >
                        Dry Run
                      </Link>
                      <Button
                        variant="secondary"
                        type="button"
                        disabled={syncingId === link.id}
                        onClick={() => syncNow(link.id)}
                      >
                        {syncingId === link.id ? "Syncing..." : "Sync Now"}
                      </Button>
                      <Link
                        href={`/dashboard/links/${link.id}/history`}
                        class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
                      >
                        History
                      </Link>
                      <Link
                        href={`/dashboard/links/${link.id}`}
                        class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
                      >
                        Edit
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
