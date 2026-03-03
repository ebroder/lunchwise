import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import cron from "node-cron";
import { app } from "./app.js";
import { initSharedDb } from "./lib/db.js";
import { syncAllEnabled } from "./lib/sync.js";

const port = parseInt(process.env.PORT || "3000", 10);

app.use("/public/*", serveStatic({ root: "./" }));

await initSharedDb();

// Sync all enabled links every 2 hours
cron.schedule("0 */2 * * *", async () => {
  console.log("Cron: starting sync of all enabled links");
  try {
    await syncAllEnabled();
    console.log("Cron: sync complete");
  } catch (err) {
    console.error("Cron: sync failed", err);
  }
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`Lunchwise running on http://localhost:${port}`);
});
