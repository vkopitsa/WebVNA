import { test, expect, connectSim, openApp } from "./fixtures.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("mobile layout: drawer, charts, no horizontal overflow, touch on the chart", async ({ page }) => {
  await openApp(page);
  await connectSim(page);
  await page.getByRole("button", { name: "Sweep", exact: true }).tap();
  await expect.poll(() => page.evaluate(() => window.webvna.state().sweepCount)).toBeGreaterThan(0);

  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(overflow.sw, "page scrolls horizontally").toBeLessThanOrEqual(overflow.cw + 1);

  const side = page.getByRole("complementary", { name: "Settings" });
  await expect(side).not.toBeInViewport();
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  await expect(side).toBeInViewport();
  await page.getByRole("tab", { name: "Display", exact: true }).tap();
  const sbox = await side.boundingBox();
  expect(sbox!.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Close settings" }).tap();
  await expect(side).not.toBeInViewport();

  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  expect(box.width).toBeGreaterThan(200);
  expect(box.x + box.width).toBeLessThanOrEqual(391);

  // a tap moves the active marker
  const f0 = await page.evaluate(() => window.webvna.markers()[0].f);
  await page.touchscreen.tap(box.x + box.width * 0.85, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => window.webvna.markers()[0].f)).not.toBe(f0);
});

test("mobile: every tab fits the viewport width", async ({ page }) => {
  await openApp(page);
  await connectSim(page);
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  const tabs = page.locator("nav.tabs button[role=tab]");
  // fill the widest sections first: a limit segment and fixture stages (lumped, line)
  const side = page.getByRole("complementary", { name: "Settings" });
  await tabs.nth(2).tap();
  await side.getByRole("button", { name: "From current band" }).tap();
  await tabs.nth(1).tap();
  await side.getByRole("button", { name: "+ Lumped" }).first().tap();
  await side.getByRole("button", { name: "+ Line" }).first().tap();
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).tap();
    const over = await page.evaluate(() => {
      const side = document.querySelector("aside.side")!;
      const panel = side.querySelector(".panel")!;
      return { sw: panel.scrollWidth, cw: panel.clientWidth, doc: document.documentElement.scrollWidth };
    });
    expect(over.sw, `tab ${i} panel overflows`).toBeLessThanOrEqual(over.cw + 1);
    expect(over.doc).toBeLessThanOrEqual(391);
  }
});

test("mobile: two-finger pinch zooms the frequency range, vertical pinch changes scale, double-tap auto-scales", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await window.webvna.connectSimulator({ dut: "antenna" });
    window.webvna.setStimulus({ start: 400e6, stop: 470e6, points: 101 });
    await window.webvna.sweep();
  });
  const canvas = page.locator("canvas").first();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", pts: { x: number; y: number; id: number }[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });

  // horizontal pinch out: fingers move apart -> narrower range
  await touch("touchStart", [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }]);
  for (let k = 1; k <= 6; k++) await touch("touchMove", [{ x: cx - 30 - k * 12, y: cy, id: 1 }, { x: cx + 30 + k * 12, y: cy, id: 2 }]);
  await touch("touchEnd", []);
  await expect.poll(() => page.evaluate(() => { const s = window.webvna.state(); return s.stop - s.start; })).toBeLessThan(60e6);

  // vertical pinch: scale/div of the active trace changes
  const before = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("webvna.settings.v1") ?? "{}").traces?.[0]?.scale));
  await touch("touchStart", [{ x: cx, y: cy - 30, id: 1 }, { x: cx, y: cy + 30, id: 2 }]);
  for (let k = 1; k <= 6; k++) await touch("touchMove", [{ x: cx, y: cy - 30 - k * 8, id: 1 }, { x: cx, y: cy + 30 + k * 8, id: 2 }]);
  await touch("touchEnd", []);
  await expect.poll(() => page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("webvna.settings.v1") ?? "{}").traces?.[0]?.scale))).not.toBe(before);

  // double tap -> auto scale
  await page.touchscreen.tap(cx, cy);
  await page.touchscreen.tap(cx, cy);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("webvna.settings.v1") ?? "{}").traces?.[0]?.scale?.auto)).toBe(true);
});
