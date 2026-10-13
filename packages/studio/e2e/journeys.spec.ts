import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { movementModel } from "./fixtures/models/movement.js";
import { audioModel } from "./fixtures/models/audio.js";
import { speechModel } from "./fixtures/models/speech.js";
import { codeModel } from "./fixtures/models/code.js";
import { visualModel } from "./fixtures/models/visual.js";
import { fixtureEvidence, fixtureThemes, guardNetwork, seed } from "./helpers.js";

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

const cta = (page: Page) => page.locator("footer.las-cta .las-btn.primary");

async function expectTheme(page: Page, themeId: string) {
  const theme = themes[themeId];
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme-id", themeId);
  for (const k of ["card", "button", "chip", "tile", "progress", "route", "meter"]) await expect(html).toHaveAttribute(`data-${k}`, theme.components[k]);
}

async function onboard(page: Page, name: string) {
  await page.goto("/app/onboard/new");
  await page.locator(".las-tile", { hasText: name }).click();
  await page.waitForURL(/\/app\/onboard\/int_/);
  // why: chips, then continue
  await expect(page.locator(".las-h1")).toContainText("pulling you toward");
  await page.locator(".las-chip", { hasText: "For fun" }).click();
  await cta(page).click();
  // picture: one tile moves on by itself
  await expect(page.locator(".las-h1")).toContainText("Six months from now");
  await page.locator(".las-tile", { hasText: "Doing it every week" }).click();
  // the level probe
  await expect(page.locator(".las-h1")).toContainText("How much have you done?");
  await page.locator(".las-tile", { hasText: "A few times" }).click();
  // placement: too easy, then too hard, then looks right
  await expect(page.locator(".las-h1")).toContainText("Here's where you start");
  await page.getByRole("button", { name: "Too easy" }).click();
  await expect(page.getByRole("button", { name: "Too hard" })).toBeEnabled();
  await page.getByRole("button", { name: "Too hard" }).click();
  await expect(page.locator(".las-rung.here")).toContainText("Brand new");
  await cta(page).click();
  // time: slider and a deadline
  await expect(page.locator(".las-h1")).toContainText("How much time");
  await page.locator("input#minutes").fill("240");
  await expect(page.locator(".las-bignum")).toContainText("4 hours");
  await page.locator(".las-chip", { hasText: "3 months" }).click();
  await cta(page).click();
  // around
  await expect(page.locator(".las-h1")).toContainText("plan around");
  await page.locator(".las-chip", { hasText: "A quiet room" }).click();
  await cta(page).click();
  // milestone: the quick win
  await expect(page.locator(".las-h1")).toContainText("first milestone");
  await page.locator(".las-tile", { hasText: "First clean attempt" }).click();
  await expect(cta(page)).toHaveText(/Build my plan/);
  await cta(page).click();
  // the plan, then Start
  await expect(page.locator(".las-hero .las-h1")).toBeVisible();
  await expect(cta(page)).toHaveText(/Start session 1/);
  await cta(page).click();
  await page.waitForURL(/\/app\/today\?sk=/);
}

/** One capture on the shared Recording screen, then "Check it". */
async function capture(page: Page, engine: string) {
  const rec = page.locator(`[data-engine="${engine}"]`).first();
  await expect(rec).toBeVisible();
  if (engine === "code") {
    await expect(page.locator(".las-textarea")).toHaveValue(/function add/);
    await page.getByRole("button", { name: "Run the tests", exact: true }).click();
    await expect(page.locator(".las-testlist li.fail").first()).toBeVisible();
  } else if (engine === "visual") {
    const take = page.getByRole("button", { name: "Record", exact: true });
    await expect(take).toBeEnabled({ timeout: 20_000 });
    await take.click();
    await page.locator(".las-tapimg").click({ position: { x: 40, y: 40 } });
  } else {
    const record = page.getByRole("button", { name: "Record", exact: true });
    await expect(record).toBeEnabled({ timeout: 20_000 });
    await record.click();
    const stop = page.getByRole("button", { name: /^Stop/ });
    await expect(stop).toBeVisible();
    await page.waitForTimeout(1200);
    await stop.click();
  }
  await expect(cta(page)).toHaveText("Check it");
  await cta(page).click();
  // analysis on the device, then the feedback card
  await expect(page.locator(".las-feedback .headline").first()).toBeVisible({ timeout: 30_000 });
}

async function answerDrill(page: Page) {
  const drill = page.locator("[data-drill]");
  await expect(drill.locator(".las-opt").first()).toBeVisible();
  // every fixture item's right answer is the first option
  for (let i = 0; i < 6; i++) {
    if (/Drill done/.test((await drill.textContent()) ?? "")) break;
    const before = (await drill.locator(".las-prompt").first().textContent().catch(() => "")) ?? "";
    await drill.locator(".las-opt").first().click();
    await expect.poll(async () => {
      const text = (await drill.textContent()) ?? "";
      const now = (await drill.locator(".las-prompt").first().textContent({ timeout: 200 }).catch(() => "")) ?? "";
      return /Drill done/.test(text) || now !== before;
    }).toBe(true);
  }
  await expect(drill).toContainText(/Drill done/);
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
