import { isNotNull } from "drizzle-orm";
import { getSharedDb } from "./db.js";
import { describeError } from "./errors.js";
import { getExchangeRates, type ExchangeRates } from "./exchange-rates.js";
import { createLogger } from "./logger.js";
import {
  REQUEST_WARNING,
  requestBudgetExceeded,
  requestsUsed,
  withRequestBudget,
} from "./request-budget.js";
import { users } from "./schema-shared.js";
import { syncUser } from "./sync.js";

export const SYNC_QUEUE = "lunchwise-sync";
export const SYNC_DEAD_LETTER_QUEUE = "lunchwise-sync-dlq";

export interface UserSyncMessage {
  userId: number;
  exchangeRates: ExchangeRates | null;
}

// sendBatch takes at most 100 messages and 256 KB, and each message carries about 3 KB of rates
const SEND_BATCH_SIZE = 50;

export async function enqueueUserSyncs(queue: Queue<UserSyncMessage>): Promise<void> {
  const log = createLogger({ source: "cron" });
  const shared = getSharedDb();
  const rows = await shared.select({ id: users.id }).from(users).where(isNotNull(users.tursoDbUrl));

  let exchangeRates: ExchangeRates | null = null;
  try {
    exchangeRates = await getExchangeRates(shared);
  } catch (err) {
    log.warn("Failed to load exchange rates, skipping balance sync", {
      error: describeError(err),
    });
  }

  const messages = rows.map((row) => ({ body: { userId: row.id, exchangeRates } }));
  for (let i = 0; i < messages.length; i += SEND_BATCH_SIZE) {
    await queue.sendBatch(messages.slice(i, i + SEND_BATCH_SIZE));
  }

  log.info("Queued user syncs", { users: rows.length, exchangeRates: exchangeRates !== null });
}

export async function processSyncBatch(batch: MessageBatch<UserSyncMessage>): Promise<void> {
  await withRequestBudget(async () => {
    for (const message of batch.messages) {
      await processSyncMessage(message);
    }
  });
}

async function processSyncMessage(message: Message<UserSyncMessage>): Promise<void> {
  const { userId, exchangeRates } = message.body;
  const log = createLogger({ source: "queue", userId });

  const outcome = await syncUser(userId, exchangeRates).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const requests = requestsUsed();
  log.info("User sync finished", { requests });

  if (requestBudgetExceeded()) {
    log.error(`Sync for user ${userId} ran out of requests after ${requests} requests`, {
      requests,
    });
    message.ack();
    return;
  }

  if (!outcome.ok) {
    log.error("User sync failed, will retry", {
      error: describeError(outcome.error),
      cause: outcome.error,
      attempt: message.attempts,
    });
    message.retry();
    return;
  }

  if (requests > REQUEST_WARNING) {
    log.warn(
      "User sync is close to the request budget",
      { requests },
      { fingerprint: ["request-budget-warning"] },
    );
  }
  message.ack();
}

// the only report for a run Cloudflare killed outright (over the CPU limit, say)
export function reportDeadLetters(batch: MessageBatch<UserSyncMessage>): void {
  const log = createLogger({ source: "queue" });
  for (const message of batch.messages) {
    const { userId } = message.body;
    log.error(`User ${userId}'s sync failed repeatedly`, { userId });
    message.ack();
  }
}
