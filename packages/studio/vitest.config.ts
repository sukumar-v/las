import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "studio", include: ["test/**/*.test.ts", "test/**/*.test.tsx"] } });
