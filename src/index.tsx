import * as Sentry from "@sentry/cloudflare";
import { app } from "./app.js";
import { resetKeyCache } from "./lib/crypto.js";
import { initEnv } from "./lib/env.js";
import { syncAllEnabled } from "./lib/sync.js";
import { describeError } from "./lib/errors.js";
import { createLogger } from "./lib/logger.js";

export default Sentry.withSentry(
  (env: Record<string, string>) => ({
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
    async fetch(
      request: Request,
      workerEnv: Record<string, string>,
      ctx: ExecutionContext,
    ): Promise<Response> {
      initEnv(workerEnv);
      resetKeyCache();
      return app.fetch(request, workerEnv, ctx);
    },

    async scheduled(
      _event: ScheduledController,
      workerEnv: Record<string, string>,
      ctx: ExecutionContext,
    ): Promise<void> {
      initEnv(workerEnv);
      resetKeyCache();
      const log = createLogger({ source: "cron" });
      ctx.waitUntil(
        Sentry.withMonitor("lunchwise-sync", () => syncAllEnabled(), {
          schedule: { type: "crontab", value: "0 */2 * * *" },
          checkinMargin: 5,
          maxRuntime: 10,
          timezone: "UTC",
        }).catch((err) => {
          log.error("Cron handler failed", { error: describeError(err), cause: err });
        }),
      );
    },
  } satisfies ExportedHandler<Record<string, string>>,
);
