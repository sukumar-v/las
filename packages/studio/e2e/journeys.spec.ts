import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { movementModel } from "./fixtures/models/movement.js";
import { audioModel } from "./fixtures/models/audio.js";
import { speechModel } from "./fixtures/models/speech.js";
import { codeModel } from "./fixtures/models/code.js";
import { visualModel } from "./fixtures/models/visual.js";
import { answerDrill, capture, cta, fixtureEvidence, fixtureThemes, guardNetwork, onboard, seed } from "./helpers.js";

/**
 * Onboarding → session 1 → Today for five skills on five different engines, each in a different fixture theme.
 * Devices are Chromium's fake camera and microphone; the evidence comes from the fixture hook so analysis is
 * deterministic and needs no model downloads. Journeys run one after another: each applies its theme to
 * everything, and the assertions check that the page wears it.
 */
test.describe.configure({ mode: "serial" });

const SHOTS = join(import.meta.dirname, "screenshots");
mkdirSync(SHOTS, { recursive: true });
const themes = Object.fromEntries(fixtureThemes().map((t) => [t.id, t.theme]));
const evidence = fixtureEvidence();

const JOURNEYS = [
  { engine: "movement", model: movementModel, theme: "brutalist" },
  { engine: "audio", model: audioModel, theme: "dark-neon" },
  { engine: "speech", model: speechModel, theme: "glass" },
  { engine: "code", model: codeModel, theme: "playful-rounded" },
  { engine: "visual", model: visualModel, theme: "monochrome-serif" }
] as const;

async function expectTheme(page: Page, themeId: string) {
  const theme = themes[themeId];
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme-id", themeId);
  for (const k of ["card", "button", "chip", "tile", "progress", "route", "meter"]) await expect(html).toHaveAttribute(`data-${k}`, theme.components[k]);
}

for (const j of JOURNEYS) {
  test(`${j.engine}: onboarding, session 1, Today (${j.theme})`, async ({ page, request }, testInfo) => {
    test.setTimeout(150_000);
    const { skillModelId } = await seed(request, { model: j.model, theme: themes[j.theme] });
    expect(skillModelId).toBeTruthy();
    const external = await guardNetwork(page);
    await page.addInitScript((ev) => {
      (window as unknown as { __lasFixture: unknown }).__lasFixture = { evidence: ev };
    }, { [j.engine]: evidence[j.engine] });

    await onboard(page, j.model.name);
    await expectTheme(page, j.theme);

    // Today, first day
    await expect(page.locator('[data-state="first-day"]')).toBeVisible();
    await page.getByRole("button", { name: "Start session" }).click();
    await page.waitForURL(/\/app\/session\//);

    // warm-up (physical skills)
    if (j.model.physical) {
      await expect(page.locator(".las-h1")).toContainText("Warm-up");
      for (const chip of await page.locator(".las-steps .las-chip").all()) await chip.click();
      await cta(page).click();
    }
    // learn: predict, then the sim slider
    await expect(page.locator(".las-card", { hasText: "predict" }).first()).toBeVisible();
    await page.locator(".las-card", { hasText: "predict" }).locator(".las-opt").first().click();
    const sim = page.locator(".las-sim input[type=range]").first();
    await sim.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await cta(page).click();
    // practice: the quick check
    await answerDrill(page);
    await cta(page).click();
    // perform: capture → analysis → feedback with a headline and Try this
    await capture(page, j.engine);
    await expect(page.locator(".las-feedback .headline").first()).toHaveText(j.model.mistakes[0].headline!);
    if (j.engine === "visual") await expect(page.locator("main")).toContainText("grading pending");
    await shot(page, testInfo, `${j.engine}-feedback`);
    const tryThis = page.getByRole("button", { name: /^Try this/ });
    await expect(tryThis).toBeVisible();
    await tryThis.click();
    // the fix drill
    await expect(page.locator('[data-drill="choice"]')).toBeVisible();
    await answerDrill(page);
    await cta(page).click();
    // the second attempt
    await capture(page, j.engine);
    await cta(page).click();
    // wrap-up
    await expect(page.locator(".las-h1", { hasText: "Done" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".las-card", { hasText: "Next session" })).toBeVisible();
    await cta(page).click();

    // Today: the next session and the week's dots
    await page.waitForURL(/\/app\/today\?sk=/);
    await expect(page.locator(".las-card", { hasText: "Next session" })).toBeVisible();
    await expect(page.locator('[data-state="first-day"]')).toHaveCount(0);
    await expect(page.locator(".las-weekdots i.done")).toHaveCount(1);
    await expectTheme(page, j.theme);
    await shot(page, testInfo, `${j.engine}-today-after`);

    if (j.engine === "code" && hasNode()) {
      // a drill pinned to this computer's toolchain: the first run asks for consent
      const sk = new URL(page.url()).searchParams.get("sk")!;
      await page.addInitScript(() => {
        const f = (window as unknown as { __lasFixture?: { evidence?: Record<string, unknown> } }).__lasFixture;
        if (f?.evidence && location.pathname.startsWith("/app/drill/")) delete f.evidence.code;
      });
      await page.goto(`/app/drill/local-build?sk=${sk}`);
      await expect(page.locator(".las-textarea")).toHaveValue(/function twice/);
      await page.getByRole("button", { name: "Run the tests", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toContainText("First run");
      await page.getByRole("button", { name: "Allow and run" }).click();
      await expect(page.locator(".las-testlist li.pass")).toHaveCount(1, { timeout: 30_000 });
    }
    expect(external).toEqual([]);
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const path = join(SHOTS, `journey-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function hasNode(): boolean {
  try {
    execFileSync("node", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
