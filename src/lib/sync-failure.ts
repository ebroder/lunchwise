import { and, eq, inArray, max, ne } from "drizzle-orm";
import type { UserDb } from "./db.js";
import { classifySyncError, describeError, type SyncFailureReason } from "./errors.js";
import type { Logger } from "./logger.js";
import { credentials, syncLog } from "./schema-user.js";

const credentialRejections: Partial<Record<SyncFailureReason, string>> = {
  "lunch-money-key": "Lunch Money rejected the user's API key",
  "splitwise-access": "Splitwise rejected the user's access token",
};

export function isCredentialRejection(reason: SyncFailureReason): boolean {
  return reason in credentialRejections;
}

// Only the user can replace a dead credential, so those are warnings, grouped so that a burst
// (more likely a bug on our side) still shows up in one issue.
export function logSyncFailure(
  log: Logger,
  msg: string,
  err: unknown,
  fields: Record<string, unknown> = {},
): SyncFailureReason {
  const error = describeError(err);
  const reason = classifySyncError(error);
  const rejection = credentialRejections[reason];
  if (rejection) {
    log.warn(
      `${msg}: ${rejection}`,
      { ...fields, error },
      { fingerprint: ["sync-credential-rejected", reason] },
    );
  } else {
    log.error(msg, { ...fields, error, cause: err });
  }
  return reason;
}

export const syncFailureMessages: Record<SyncFailureReason, string> = {
  "lunch-money-key":
    "Lunch Money no longer accepts your API key. Enter a new one under Connections.",
  "splitwise-access": "Splitwise no longer accepts Lunchwise's access. Log out and log back in.",
  interrupted: "It stopped before finishing.",
  other: "See History for details.",
};

export interface SyncFailure {
  at: string;
  reason: SyncFailureReason;
  message: string;
}

// Each link whose latest finished sync failed, in one Turso request.
export async function getSyncFailures(db: UserDb): Promise<Map<number, SyncFailure>> {
  const latestFinished = db
    .select({ id: max(syncLog.id) })
    .from(syncLog)
    .where(ne(syncLog.status, "running"))
    .groupBy(syncLog.linkId);
  const failedLatest = and(eq(syncLog.status, "error"), inArray(syncLog.id, latestFinished));
  const [rows, creds, successes] = await db.batch([
    db
      .select({
        linkId: syncLog.linkId,
        startedAt: syncLog.startedAt,
        errorMessage: syncLog.errorMessage,
      })
      .from(syncLog)
      .where(failedLatest),
    db
      .select({
        lunchMoneyKeyUpdatedAt: credentials.lunchMoneyKeyUpdatedAt,
        splitwiseTokenUpdatedAt: credentials.splitwiseTokenUpdatedAt,
      })
      .from(credentials)
      .limit(1),
    db
      .select({ startedAt: max(syncLog.startedAt) })
      .from(syncLog)
      .where(eq(syncLog.status, "success")),
  ]);

  // a rejection stops counting once that credential is replaced or any link syncs after it
  const lastSuccess = successes[0]?.startedAt;
  const clearedAt: Partial<Record<SyncFailureReason, (string | null | undefined)[]>> = {
    "lunch-money-key": [creds[0]?.lunchMoneyKeyUpdatedAt, lastSuccess],
    "splitwise-access": [creds[0]?.splitwiseTokenUpdatedAt, lastSuccess],
  };
  const failures = new Map<number, SyncFailure>();
  for (const row of rows) {
    const reason = classifySyncError(row.errorMessage ?? "");
    const startedAt = Date.parse(row.startedAt);
    if (clearedAt[reason]?.some((at) => at && Date.parse(at) > startedAt)) continue;
    failures.set(row.linkId, {
      at: row.startedAt,
      reason,
      message: syncFailureMessages[reason],
    });
  }
  return failures;
}
