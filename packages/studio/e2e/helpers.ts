import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type APIRequestContext } from "@playwright/test";

export const THEMES_DIR = join(import.meta.dirname, "../../../evals/fixtures/themes");

/** The six fixture themes (brutalist, monochrome serif, playful rounded, dark neon, glass, high contrast). */
export function fixtureThemes(): { id: string; theme: any }[] {
  return readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const theme = JSON.parse(readFileSync(join(THEMES_DIR, f), "utf8"));
      return { id: theme.id as string, theme };
    });
}

export function fixtureEvidence(): Record<string, any> {
  return JSON.parse(readFileSync(join(import.meta.dirname, ".fixtures/evidence.json"), "utf8"));
}

export async function seed(request: APIRequestContext, body: { model?: unknown; theme?: unknown; apply?: boolean }): Promise<{ skillModelId?: string; themeId?: string }> {
  const r = await request.post("/api/e2e/seed", { data: body });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return j;
}

/** Fails the test on any request that leaves this computer. */
export async function guardNetwork(page: Page): Promise<string[]> {
  const external: string[] = [];
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(u.hostname) || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    external.push(u.href);
    return route.abort();
  });
  return external;
}

/** Layout and accessibility checks run inside the page (theming §8). */
export async function layoutIssues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const issues: string[] = [];
    const se = document.scrollingElement ?? document.documentElement;
    if (se.scrollWidth > innerWidth + 1) issues.push(`horizontal overflow: ${se.scrollWidth} > ${innerWidth}`);
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    // overlap: cards, tiles and buttons never cover each other (sticky bars and nested boxes aside)
    const boxes = [...document.querySelectorAll(".las-card, .las-tile, .las-btn")].filter((el) => visible(el) && !el.closest(".las-cta, .las-top, .las-studio-nav, .las-overlay"));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ix > 1 && iy > 1) issues.push(`overlap: ${a.className} [${a.textContent?.trim().slice(0, 30)}] / ${b.className} [${b.textContent?.trim().slice(0, 30)}]`);
      }
    // elements wider than the viewport
    for (const el of document.querySelectorAll(".las-app *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > innerWidth + 1 && !el.closest(".las-ribbon, .las-route, .las-code, pre, .las-sr")) {
        const s = getComputedStyle(el);
        if (s.position !== "fixed") {
          issues.push(`too wide: ${el.tagName.toLowerCase()}.${(el as HTMLElement).className} right=${Math.round(r.right)}`);
          break;
        }
      }
    }
    // tap targets
    for (const el of document.querySelectorAll(".las-btn, .las-chip, .las-iconbtn, .las-tile, .las-opt")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 43.5) issues.push(`tap target ${Math.round(r.height)}px: ${(el as HTMLElement).className} [${el.textContent?.trim().slice(0, 20)}]`);
    }
    // contrast of body text on the background, and card text on its surface
    const rgb = (c: string): number[] | undefined => {
      const cv = document.createElement("canvas").getContext("2d")!;
      cv.fillStyle = "#000";
      cv.fillStyle = c;
      cv.fillRect(0, 0, 1, 1);
      const d = cv.getImageData(0, 0, 1, 1).data;
      return d[3] === 0 ? undefined : [d[0], d[1], d[2]];
    };
    const lum = (c: number[]) => {
      const l = c.map((x) => {
        const s = x / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const root = getComputedStyle(document.documentElement);
    const ink = rgb(root.getPropertyValue("--las-color-ink").trim());
    const bg = rgb(getComputedStyle(document.body).backgroundColor) ?? rgb(root.getPropertyValue("--las-color-bg").trim());
    const surface = rgb(root.getPropertyValue("--las-color-surface").trim());
    const body = rgb(getComputedStyle(document.body).color);
    if (body && bg && ratio(body, bg) < 4.5) issues.push(`body text contrast ${ratio(body, bg).toFixed(2)}`);
    if (ink && surface && ratio(ink, surface) < 4.5) issues.push(`card text contrast ${ratio(ink, surface).toFixed(2)}`);
    return issues;
  });
}

/** Tabs through the page: every focused element shows a ring (an outline, or a box-shadow ring on fields). */
export async function focusIssues(page: Page, max = 12): Promise<string[]> {
  const issues: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow !== "none" && s.boxShadow !== "");
      return { ring, what: `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60) };
    });
    if (!r) break;
    if (!r.ring) issues.push(`no focus ring: ${r.what}`);
  }
  return issues;
}

export const cta = (page: Page) => page.locator("footer.las-cta .las-btn.primary");

/** Onboarding for a seeded model, from the skill picker to Today. */
export async function onboard(page: Page, name: string) {
  await page.goto("/app/onboard/new");
  await page.locator(".las-tile", { hasText: name }).click();
  await page.waitForURL(/\/app\/onboard\/int_/);
  // the look step shows only when no theme is active yet (a spec that seeds none may run first)
  await expect(page.locator(".las-h1")).toContainText(/pulling you toward|Pick a look/);
  if (/Pick a look/.test((await page.locator(".las-h1").textContent()) ?? "")) await page.getByRole("button", { name: "Keep it plain" }).click();
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
export async function capture(page: Page, engine: string) {
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

export async function answerDrill(page: Page) {
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
