import { app } from "./app.js";
import { initEnv } from "./lib/env.js";
import { syncAllEnabled, describeError } from "./lib/sync.js";
import { createLogger } from "./lib/logger.js";

export default {
  async fetch(
    request: Request,
    workerEnv: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<Response> {
    initEnv(workerEnv);
    return app.fetch(request, workerEnv, ctx);
  },

  async scheduled(
    _event: ScheduledEvent,
    workerEnv: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<void> {
    initEnv(workerEnv);
    const log = createLogger({ source: "cron" });
    ctx.waitUntil(
      syncAllEnabled().catch((err) => {
        log.error("Cron handler failed", { error: describeError(err) });
      }),
    );
  },
};
