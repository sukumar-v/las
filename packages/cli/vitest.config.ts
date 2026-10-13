import { defineConfig } from "vitest/config";
export default defineConfig({ test: { testTimeout: 60000, hookTimeout: 60000, name: "cli", include: ["test/**/*.test.ts", "test/**/*.test.tsx"] } });
