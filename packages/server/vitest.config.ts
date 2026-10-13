import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "server", include: ["test/**/*.test.ts", "test/**/*.test.tsx"], testTimeout: 60000, hookTimeout: 60000 } });
