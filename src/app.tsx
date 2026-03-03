import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { secureHeaders } from "hono/secure-headers";
import { Layout } from "./components/layout.js";
import { landing } from "./routes/landing.js";
import { auth } from "./routes/auth.js";
import { dashboard } from "./routes/dashboard.js";
import { api } from "./routes/api.js";
import { legal } from "./routes/legal.js";

import "./types.js";

const app = new Hono();

app.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }),
);

app.use(
  jsxRenderer(({ children, title, bare }) => {
    return (
      <Layout title={title} bare={bare}>
        {children}
      </Layout>
    );
  }),
);

app.route("/", landing);
app.route("/auth", auth);
app.route("/dashboard", dashboard);
app.route("/api", api);
app.route("/", legal);

export { app };
