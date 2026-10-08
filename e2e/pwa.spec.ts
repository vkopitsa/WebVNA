import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, openApp } from "./fixtures.ts";

// The update test rewrites dist/sw.js while it runs, so the two tests must not overlap.
test.describe.configure({ mode: "serial" });

test("service worker registers, sw.js is served, and the app reloads offline", async ({ page, context, request }) => {
  const res = await request.get("sw.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/javascript/);
  expect((await request.get("manifest.webmanifest")).status()).toBe(200);

  await openApp(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // first visit is not controlled yet; reload once the worker is active
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
  expect(scope).toBe("http://localhost:4173/");

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Simulator", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Simulator", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await context.setOffline(false);
});

test("an updated service worker shows the update prompt", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // Make the served worker byte-different (page.route cannot intercept the worker script fetch), then ask for an update.
  const file = resolve("dist/sw.js");
  const original = await readFile(file, "utf8");
  try {
    await writeFile(file, original + `\n// e2e update ${Date.now()}\n`);
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect(page.getByText("Update available")).toBeVisible({ timeout: 20_000 });
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Reload", exact: true }).click()]);
  } finally {
    await writeFile(file, original);
  }
  await expect(page.getByRole("button", { name: "Simulator", exact: true })).toBeVisible();
});
