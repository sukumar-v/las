import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "engines", include: ["test/**/*.test.ts", "test/**/*.test.tsx"] } });
