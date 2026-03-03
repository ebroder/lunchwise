import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: "esm",
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
});
