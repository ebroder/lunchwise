import { app } from "./app.js";
import { initEnv } from "./lib/env.js";
import { syncAllEnabled } from "./lib/sync.js";

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
    ctx.waitUntil(
      syncAllEnabled().then(
        () => console.log("Cron: sync complete"),
        (err) => console.error("Cron: sync failed", err),
      ),
    );
  },
};
