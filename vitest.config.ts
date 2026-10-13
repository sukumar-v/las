import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/schema",
      "packages/store",
      "packages/server",
      "packages/ui",
      "packages/engines",
      "packages/runners",
      "packages/cli",
      "packages/studio",
      "evals"
    ]
  }
});
