import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_SCREENS } from "../src/snapshots/names.js";
import { fixtureThemes, focusIssues, guardNetwork, layoutIssues, seed } from "./helpers.js";

/**
 * Theming §8: the main screens in six very different themes, at phone and tablet sizes. Nothing overflows or
 * overlaps, every focusable element shows a focus ring, buttons are at least 44 px, body text has 4.5:1 contrast.
 */
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 1024, height: 768 }
];
const SHOTS = join(import.meta.dirname, "screenshots");
mkdirSync(SHOTS, { recursive: true });

// the base theme too: it carries the variants none of the six fixtures pick (progress bar, meter bar)
const THEMES: { id: string; theme: any }[] = [{ id: "base", theme: undefined }, ...fixtureThemes()];

for (const { id, theme: fixture } of THEMES) {
  for (const vp of id === "base" ? VIEWPORTS.slice(0, 1) : VIEWPORTS) {
    test(`${id} at ${vp.name}`, async ({ page, request }, testInfo) => {
      const theme = fixture ?? (await (await request.get("/api/themes/base")).json()).theme;
      if (fixture) await seed(request, { theme, apply: false });
      const external = await guardNetwork(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const problems: string[] = [];
      for (const screen of SNAPSHOT_SCREENS) {
        await page.goto(`/snapshots?theme=${id}&screen=${screen}`);
        await page.locator(`[data-screen="${screen}"]`).waitFor();
        await expect(page.locator("html")).toHaveAttribute("data-theme-id", id);
        await expect(page.locator("html")).toHaveAttribute("data-card", theme.components.card);
        for (const issue of await layoutIssues(page)) problems.push(`${screen}: ${issue}`);
        for (const issue of await focusIssues(page)) problems.push(`${screen}: ${issue}`);
        const file = join(SHOTS, `${id}-${screen}-${vp.name}.png`);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.screenshot({ path: file, fullPage: true });
        await testInfo.attach(`${id}-${screen}-${vp.name}`, { path: file, contentType: "image/png" });
      }
      expect(problems, problems.join("\n")).toEqual([]);
      expect(external).toEqual([]);
    });
  }
}
