import { test, expect } from "@playwright/test";
import { guardNetwork } from "./helpers.js";

/** Phone pairing (DESIGN §10, mcp-and-data §8): a QR code when mkcert can make HTTPS for the LAN, else a note. */
test("settings shows a pairing QR code, or says pairing needs mkcert", async ({ page, request }) => {
  const external = await guardNetwork(page);
  const info = await (await request.get("/api/pair")).json();
  await page.goto("/settings");
  const section = page.locator('[data-section="pair"]');
  await expect(section).toBeVisible();
  if (info.available) {
    await expect(section.locator(".las-qr svg path.m")).toBeVisible();
    await expect(section.locator(".las-url").first()).toContainText("/pair/pair_");
    expect(info.urls[0]).toMatch(/^https:\/\/\d+\.\d+\.\d+\.\d+:\d+\/pair\//);
  } else {
    await expect(section).toContainText(info.reason === "mkcert" ? "mkcert" : "network");
    await expect(section.locator(".las-qr")).toHaveCount(0);
  }
  expect(external).toEqual([]);
});

test("a bad pairing token shows an error", async ({ page }) => {
  await page.goto("/pair/pair_not-a-real-token");
  await expect(page.locator(".las-h1")).toHaveText("Couldn't pair");
  await expect(page.locator(".las-note")).toContainText("used up or expired");
});

test("the claim route refuses a used or unknown token", async ({ request }) => {
  const r = await request.post("/api/pair/claim", { data: { token: "pair_nope" } });
  expect(r.status()).toBe(400);
});
