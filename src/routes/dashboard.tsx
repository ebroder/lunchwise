import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../lib/auth.js";
import { spaHtml } from "../generated/spa-html.js";

const dashboard = new Hono<AuthEnv>();

dashboard.use("*", requireAuth);

dashboard.get("/*", (c) => {
  return c.html(spaHtml);
});

export { dashboard };
