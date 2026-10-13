import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end suite: builds the studio, starts the LAS server on 127.0.0.1:4799 with a throwaway data folder
 * and the test-only seeding route, then drives Chromium with fake camera and microphone devices.
 */
const PORT = Number(process.env.LAS_E2E_PORT ?? 4799);
const here = import.meta.dirname;
const home = process.env.LAS_E2E_HOME ?? (process.env.LAS_E2E_HOME = mkdtempSync(join(tmpdir(), "las-e2e-")));

export default defineConfig({
  testDir: join(here, "e2e"),
  outputDir: join(here, "test-results"),
  globalSetup: join(here, "e2e/global-setup.ts"),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    permissions: ["camera", "microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
    serviceWorkers: "block",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm run build && pnpm --filter @las/server exec tsx src/bin.ts",
    cwd: here,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { LAS_HOME: home, LAS_PORT: String(PORT), LAS_E2E: "1", LAS_STUDIO_DIST: join(here, "dist") }
  }
});
