import { test, expect } from "@playwright/test";
import { today, feedback, liveScreens, coachMessage } from "../src/snapshots/fixtures.js";
import { fixtureThemes } from "./helpers.js";

/**
 * The MCP Apps widget (dist/widget.html) in a sandboxed iframe, driven by a minimal host that speaks the
 * protocol: it renders the tool result's view in the theme it carries, follows the host's dark mode when the
 * theme has both, and fetches nothing.
 */
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="w" sandbox="allow-scripts" src="/widget.html" style="width:390px;height:800px;border:0"></iframe>
<script>
const frame = document.getElementById("w");
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  const send = (x) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...x }, "*");
  if (m.method === "ui/initialize") send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: "test-host", version: "0" }, hostCapabilities: { openLinks: {} }, hostContext: { theme: window.__mode } } });
  else if (m.method === "ui/notifications/initialized") send({ method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "x" }], structuredContent: window.__payload } });
  else if (m.id !== undefined && m.method) send({ id: m.id, result: {} });
});
</script>`;

for (const c of [
  { theme: "glass", mode: "dark", view: "today", data: today },
  { theme: "brutalist", mode: "light", view: "feedback", data: feedback },
  // a coach_show result: the live screen with the coach's message over it
  { theme: "dark-neon", mode: "dark", view: "coach", data: { liveSessionId: "ses_1", sk: "sk_test", state: "live", coachPresent: true, screen: liveScreens.lesson, message: coachMessage } as any }
]) {
  test(`widget renders ${c.view} in ${c.theme} (${c.mode} host)`, async ({ page }) => {
    const theme = fixtureThemes().find((t) => t.id === c.theme)!.theme;
    const frameRequests: string[] = [];
    page.on("request", (r) => {
      if (r.frame() !== page.mainFrame() && !r.url().endsWith("/widget.html")) frameRequests.push(r.url());
    });
    await page.route("**/__host", (route) => route.fulfill({ contentType: "text/html", body: HOST }));
    await page.addInitScript(({ payload, mode }) => {
      (window as any).__payload = payload;
      (window as any).__mode = mode;
    }, { payload: { view: c.view, title: c.view, data: c.data, theme, themeId: c.theme, studioLink: "http://127.0.0.1:4711/app/today", sk: "sk_test" }, mode: c.mode });
    await page.goto("/__host");
    const w = page.frameLocator("#w");
    if (c.view === "today") await expect(w.locator(".las-h1")).toHaveText("Today");
    else if (c.view === "coach") {
      await expect(w.locator('.las-presence[data-presence="here"]')).toBeVisible();
      await expect(w.locator(".las-coachmsg-text")).toHaveText(coachMessage.text);
      await expect(w.locator('[data-live-kind="lesson"] .las-card').first()).toBeVisible();
      await expect(w.locator(".las-ask")).toHaveCount(0);
    } else await expect(w.locator(".las-feedback .headline").first()).toHaveText(c.data.headline as string);
    const html = w.locator("html");
    await expect(html).toHaveAttribute("data-card", theme.components.card);
    await expect(html).toHaveAttribute("data-theme-id", c.theme);
    if (theme.modes.length > 1) await expect(html).toHaveAttribute("data-mode", c.mode);
    expect(frameRequests).toEqual([]);
  });
}
