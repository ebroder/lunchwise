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
  more_to_sync: boolean;
}

export function formatSyncResult(result: SyncCounts): string {
  const counts = `${result.created} created, ${result.updated} updated, ${result.deleted} deleted`;
  return result.more_to_sync
    ? `Synced so far: ${counts}. Older expenses will follow in later syncs.`
    : `Sync complete: ${counts}.`;
}
