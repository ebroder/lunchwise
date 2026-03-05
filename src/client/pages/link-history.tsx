import { useState, useEffect } from "preact/hooks";
import { Link } from "wouter";
import { api, ApiError } from "../lib/api.js";
import { card, alertError } from "../components/ui.js";

interface LogEntry {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  expensesFetched: number | null;
  created: number | null;
  updated: number | null;
  deleted: number | null;
  errorMessage: string | null;
}

export function LinkHistory({ params }: { params: { id: string } }) {
  const linkId = params.id;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ logs: LogEntry[]; hasMore: boolean }>(`/api/links/${linkId}/history`)
      .then((data) => {
        setLogs(data.logs);
        setHasMore(data.hasMore);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to load history");
      })
      .finally(() => setLoading(false));
  }, [linkId]);

  return (
    <div>
      <div class="mb-6">
        <Link
          href={`/dashboard/links/${linkId}`}
          class="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
        >
          &larr; Back to link
        </Link>
      </div>

      <h1 class="text-2xl font-bold mb-6">Sync History</h1>

      {error && <div class={alertError}>{error}</div>}

      {loading ? (
        <p class="text-sm text-stone-500 dark:text-stone-400">Loading...</p>
      ) : logs.length > 0 ? (
        <>
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
                  <tr key={log.id}>
                    <td class="px-4 py-2 text-stone-700 dark:text-stone-300">{log.startedAt}</td>
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
          {hasMore && (
            <p class="text-sm text-stone-500 dark:text-stone-400 mt-3">Showing last 50 syncs.</p>
          )}
        </>
      ) : !error ? (
        <p class="text-sm text-stone-500 dark:text-stone-400">No sync runs yet.</p>
      ) : null}
    </div>
  );
}
