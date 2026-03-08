export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface SyncCounts {
  created: number;
  updated: number;
  deleted: number;
}

export function formatSyncResult(result: SyncCounts): string {
  return `Sync complete: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted.`;
}
