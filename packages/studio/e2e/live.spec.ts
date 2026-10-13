import { test, expect, type Page, type Request } from "@playwright/test";
import { codeModel } from "./fixtures/models/code.js";
import { answerDrill, capture, cta, fixtureEvidence, guardNetwork, onboard, seed } from "./helpers.js";

/**
 * A live session with no coach (live-coach §8, "coach-away"), end to end against the real server: Today's Start
 * makes a live session, every screen comes from the fallback content at once (no coach means no screen
 * deadline to wait for), the ask box posts learner.asked, pause and resume work, closing the tab pauses the session
 * and a reload resumes it, and the wrap-up ends the session with its summary. The coach-present path is covered by
 * the server's own tests (the coach tools are MCP, out of reach from here).
 */

// its own skill, so it never shares an enrollment with the journeys running beside it
const liveModel = { ...structuredClone(codeModel), skill: "e2e live coach skill", name: "Live coach functions", noun: "live coach functions" };
const evidence = fixtureEvidence();

const frame = (page: Page) => page.locator("[data-live-kind]");

async function kindOf(page: Page): Promise<{ kind: string | null; id: string | null }> {
  const f = frame(page);
  return { kind: await f.getAttribute("data-live-kind"), id: await f.getAttribute("data-live-screen") };
}

/** Waits until the frame shows a screen other than `before` (or the session leaves the page). */
async function nextScreen(page: Page, before: { kind: string | null; id: string | null }) {
  await expect
    .poll(async () => {
      if (!/\/app\/session\//.test(page.url())) return true;
      const now = await kindOf(page).catch(() => ({ kind: null, id: null }));
      return now.kind !== "waiting" && now.kind !== "loading" && (now.id !== before.id || now.kind !== before.kind);
    }, { timeout: 45_000 })
    .toBe(true);
}

test("live session, no coach: fallback screens, ask the coach, pause, reload, wrap-up", async ({ page, request }) => {
  test.setTimeout(180_000);
  await seed(request, { model: liveModel });
  const external = await guardNetwork(page);
  await page.addInitScript((ev) => {
    (window as unknown as { __lasFixture: unknown }).__lasFixture = { evidence: ev };
  }, { code: evidence.code });
  const events: any[] = [];
  page.on("request", (r: Request) => {
    if (r.url().endsWith("/api/events") && r.method() === "POST") {
      try {
        const body = r.postDataJSON();
        if (body) events.push(body);
      } catch {
        /* a beacon's body may not parse here */
      }
    }
  });

  await onboard(page, liveModel.name);

  // Today's Start makes a live session; with no coach it's coach-away and the first screen shows at once
  const started = page.waitForResponse((r) => r.url().endsWith("/api/live/start") && r.request().method() === "POST");
  await page.locator('section[aria-label="Next session"] .las-btn.primary').click();
  const startRes = await started;
  expect(startRes.ok(), await startRes.text()).toBe(true);
  const startView = await startRes.json();
  expect(startView.state).toBe("coach-away");
  expect(startView.coachPresent).toBe(false);
  await page.waitForURL(/\/app\/session\//);
  const sessionId = new URL(page.url()).pathname.split("/").pop()!;
  expect(sessionId).toBe(startView.liveSessionId);

  await expect(page.locator('.las-presence[data-presence="away"]')).toBeVisible();
  await expect(frame(page)).not.toHaveAttribute("data-live-kind", /waiting|loading/);
  const first = await kindOf(page);
  expect(first.id).toBeTruthy();
  await expect.poll(() => events.some((e) => e.type === "screen.viewed" && e.screenId === first.id)).toBe(true);

  // the ask box: the help line says the coach answers when back; the words go out as learner.asked
  await expect(page.locator(".las-ask")).toContainText(/answer when back/i);
  const asked = page.waitForRequest((r) => r.url().endsWith("/api/events") && r.postDataJSON()?.type === "learner.asked");
  await page.locator("#las-ask").fill("Why does the order of the arguments matter?");
  await page.locator(".las-ask").getByRole("button").click();
  expect((await asked).postDataJSON()).toMatchObject({ type: "learner.asked", sessionId, screenId: first.id, text: "Why does the order of the arguments matter?" });
  await expect(page.locator(".las-ask")).toContainText(/sent/i);

  // pause and resume: the pause screen with the time so far, then the same screen again
  const paused = page.waitForRequest((r) => r.url().endsWith("/api/events") && r.postDataJSON()?.type === "session.paused");
  await page.locator(".las-live-row .las-btn").click();
  await paused;
  await expect(page.locator('[data-paused="true"]')).toBeVisible();
  await expect(page.locator(".las-pause .las-stat")).toContainText(/\d+:\d\d/);
  await expect.poll(async () => (await (await request.get(`/api/live/${sessionId}`)).json()).state).toBe("paused");
  const resumed = page.waitForRequest((r) => r.url().endsWith("/api/events") && r.postDataJSON()?.type === "session.resumed");
  await cta(page).click();
  expect((await resumed).postDataJSON()).toMatchObject({ type: "session.resumed", sessionId });
  await expect(page.locator('[data-paused="true"]')).toHaveCount(0);
  await expect(frame(page)).toHaveAttribute("data-live-screen", first.id!);
  await expect(page.locator('.las-presence[data-presence="away"]')).toBeVisible();

  // closing the page sends session.left (a beacon) and the session pauses; coming back shows Resume.
  // A beacon sent while the page unloads doesn't survive request interception, so for the reload the network
  // guard only records (anything external still fails the test) instead of routing.
  await page.unrouteAll({ behavior: "wait" });
  const recordExternal = (r: Request) => {
    const u = new URL(r.url());
    if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol !== "data:" && u.protocol !== "blob:") external.push(u.href);
  };
  page.on("request", recordExternal);
  await page.reload();
  await expect.poll(async () => (await (await request.get(`/api/live/${sessionId}`)).json()).state).toBe("paused");
  await expect(page.locator('[data-paused="true"]')).toBeVisible();
  page.off("request", recordExternal);
  external.push(...(await guardNetwork(page)));
  await cta(page).click();
  await expect(page.locator('[data-paused="true"]')).toHaveCount(0);
  await expect(frame(page)).toHaveAttribute("data-live-screen", first.id!);

  // walk the fallback screens to the wrap-up
  const seen: string[] = [];
  for (let i = 0; i < 30; i++) {
    const cur = await kindOf(page);
    seen.push(cur.kind ?? "?");
    if (cur.kind === "wrapup") break;
    switch (cur.kind) {
      case "warmup":
        for (const chip of await page.locator(".las-steps .las-chip").all()) await chip.click();
        break;
      case "lesson": {
        const predict = page.locator(".las-card", { hasText: "predict" }).locator(".las-opt").first();
        if (await predict.count()) {
          const answered = page.waitForRequest((r) => r.url().endsWith("/api/events") && r.postDataJSON()?.type === "card.answered");
          await predict.click();
          expect((await answered).postDataJSON()).toMatchObject({ type: "card.answered", sessionId, card: 0, cardType: "predict" });
        }
        const sim = page.locator(".las-sim input[type=range]").first();
        if (await sim.count()) {
          await sim.focus();
          for (let k = 0; k < 3; k++) await page.keyboard.press("ArrowRight");
        }
        break;
      }
      case "drill":
        if (await page.locator('[data-engine="code"]').count()) {
          // a performance drill: run, check it (in the drill), then the director's feedback screen
          await expect(page.locator(".las-textarea")).toHaveValue(/function/);
          await page.getByRole("button", { name: "Run the tests", exact: true }).click();
          await page.locator("main .las-btn.primary", { hasText: "Check it" }).click();
          await expect(page.locator(".las-feedback .headline").first()).toBeVisible({ timeout: 30_000 });
          continue;
        }
        if (await page.locator("[data-drill] .las-opt").count()) await answerDrill(page);
        break;
      case "capture":
        // record, check, then the director's feedback screen
        await capture(page, "code");
        continue;
      case "feedback":
        await expect(page.locator(".las-feedback .headline").first()).toHaveText(liveModel.mistakes![0].headline!);
        break;
      case "plan":
        await page.locator(".las-tile").first().click();
        break;
      default:
        break;
    }
    await expect(cta(page)).toBeEnabled({ timeout: 20_000 });
    await cta(page).click();
    await nextScreen(page, cur);
  }
  test.info().annotations.push({ type: "screens", description: seen.join(" → ") });
  console.log(`live screens: ${seen.join(" → ")}`);
  expect(seen, seen.join(" → ")).toContain("wrapup");
  expect(seen).toContain("feedback");

  // the wrap-up shows the summary; Done ends the session and goes to Today
  await expect(page.locator(".las-card", { hasText: "Next session" })).toBeVisible({ timeout: 20_000 });
  await cta(page).click();
  await page.waitForURL(/\/app\/today\?sk=/);
  const ended = await (await request.get(`/api/live/${sessionId}`)).json();
  expect(ended.state).toBe("ended");
  expect(ended.summary?.sessionId).toBe(sessionId);

  // every screen was reported with the time on the one before
  const viewed = events.filter((e) => e.type === "screen.viewed");
  expect(viewed.length).toBeGreaterThan(3);
  expect(viewed.slice(1).every((e) => e.previous && typeof e.previous.seconds === "number")).toBe(true);
  expect(external).toEqual([]);
});
