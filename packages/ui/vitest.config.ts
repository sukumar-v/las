import { defineConfig } from "vitest/config";
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: { name: "ui", include: ["test/**/*.test.ts", "test/**/*.test.tsx"] }
});
