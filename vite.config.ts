import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/styles.css": "http://localhost:8787",
    },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      exclude: ["src/lib/*-api.d.ts", "src/lib/schema-*.ts"],
    },
  },
});
