import { test as base, expect, type Page } from "@playwright/test";

/** Every test fails on console errors and uncaught page errors. */
export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await use(errors);
    expect(errors, "console errors / page errors").toEqual([]);
  }, { auto: true }],
});
export { expect };

export const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true }).click();

export async function openApp(page: Page, url = "/") {
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Simulator" })).toBeVisible();
}

/** Click the toolbar Simulator button and wait for the connection. */
export async function connectSim(page: Page) {
  await page.getByRole("button", { name: "Simulator", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

export const sweepCount = (page: Page) => page.evaluate(() => window.webvna.state().sweepCount);

/** One sweep through the toolbar button; waits for the counter to move. */
export async function sweepUi(page: Page) {
  const before = await sweepCount(page);
  await page.getByRole("button", { name: "Sweep", exact: true }).click();
  await expect.poll(() => sweepCount(page)).toBeGreaterThan(before);
}

/** Connect through the scripting API and take one sweep (fast, deterministic setup). */
export async function apiSweep(page: Page, opts: { model?: string; dut?: string; start?: number; stop?: number; points?: number } = {}) {
  await page.evaluate(async (o) => {
    await window.webvna.connectSimulator({ model: o.model as never, dut: o.dut as never });
    window.webvna.setStimulus({ start: o.start ?? 400e6, stop: o.stop ?? 470e6, points: o.points ?? 101 });
    await window.webvna.sweep();
  }, opts);
}
