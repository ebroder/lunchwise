import * as Sentry from "@sentry/cloudflare";
import { app } from "./app.js";
import { resetKeyCache } from "./lib/crypto.js";
import { initEnv } from "./lib/env.js";
import {
  enqueueUserSyncs,
  processSyncBatch,
  reportDeadLetters,
  SYNC_DEAD_LETTER_QUEUE,
  SYNC_QUEUE,
  type UserSyncMessage,
} from "./lib/sync-queue.js";
import { describeError } from "./lib/errors.js";
import { createLogger } from "./lib/logger.js";

interface WorkerEnv {
  SENTRY_DSN?: string;
  SYNC_QUEUE: Queue<UserSyncMessage>;
  [key: string]: unknown;
}

export default Sentry.withSentry(
  (env: WorkerEnv) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    // Unset fields default to collecting request bodies, which include users' Lunch Money API keys.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
        response: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
      },
      httpBodies: [],
      urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    },
  }),
  {
    async fetch(request: Request, workerEnv: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
      initEnv(workerEnv);
      resetKeyCache();
      return app.fetch(request, workerEnv, ctx);
    },

    async scheduled(
      _event: ScheduledController,
      workerEnv: WorkerEnv,
      ctx: ExecutionContext,
    ): Promise<void> {
      initEnv(workerEnv);
      resetKeyCache();
      const log = createLogger({ source: "cron" });
      // Not Sentry.withMonitor: the SDK sends check-ins captured in its forked scope outside
      // waitUntil, so the runtime cancels the closing one.
      const monitorSlug = "lunchwise-sync";
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug, status: "in_progress" },
        {
          schedule: { type: "crontab", value: "0 */2 * * *" },
          checkinMargin: 5,
          maxRuntime: 10,
          timezone: "UTC",
        },
      );
      const start = Date.now();
      const finish = (status: "ok" | "error") => {
        Sentry.captureCheckIn({
          checkInId,
          monitorSlug,
          status,
          duration: (Date.now() - start) / 1000,
        });
      };
      ctx.waitUntil(
        enqueueUserSyncs(workerEnv.SYNC_QUEUE).then(
          () => finish("ok"),
          (err) => {
            log.error("Cron handler failed", { error: describeError(err), cause: err });
            finish("error");
          },
        ),
      );
    },

    async queue(
      batch: MessageBatch<UserSyncMessage>,
      workerEnv: WorkerEnv,
      _ctx: ExecutionContext,
    ): Promise<void> {
      initEnv(workerEnv);
      resetKeyCache();
      switch (batch.queue) {
        case SYNC_QUEUE:
          await processSyncBatch(batch);
          break;
        case SYNC_DEAD_LETTER_QUEUE:
          reportDeadLetters(batch);
          break;
        default:
          throw new Error(`No consumer for queue ${batch.queue}`);
      }
    },
  } satisfies ExportedHandler<WorkerEnv, UserSyncMessage>,
);
