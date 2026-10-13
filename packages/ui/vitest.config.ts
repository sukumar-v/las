import { defineConfig } from "vitest/config";
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: { testTimeout: 60000, hookTimeout: 60000, name: "ui", include: ["test/**/*.test.ts", "test/**/*.test.tsx"] }
});
