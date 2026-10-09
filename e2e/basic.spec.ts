import { test, expect, tab, openApp, connectSim, sweepUi, sweepCount, apiSweep } from "./fixtures.ts";

test("loads, connects the simulator, sweeps and renders traces", async ({ page }) => {
  await openApp(page);
  await expect(page.getByText("No data yet.")).toBeVisible();
  await connectSim(page);
  await expect(page.locator("canvas").first()).toBeVisible();
  const before = await sweepCount(page);
  await sweepUi(page);
  expect(await sweepCount(page)).toBeGreaterThan(before);
  const markers = page.locator(".box", { has: page.getByRole("heading", { name: "Markers" }) });
  await expect(markers.locator("tbody tr").first()).toContainText("M1");
  await expect(markers.locator("tbody td").nth(2)).not.toHaveText("");
  // the chart canvases are actually painted
  const painted = await page.locator("canvas").first().evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    return false;
  });
  expect(painted).toBe(true);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Simulator", exact: true })).toBeVisible();
});

test("continuous run increments the sweep count and stops", async ({ page }) => {
  await openApp(page);
  await connectSim(page);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => sweepCount(page)).toBeGreaterThan(2);
  await page.getByRole("button", { name: /^Stop/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
});

test("window.webvna API", async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const w = window.webvna;
    let events = 0;
    const off = w.on("sweep", () => { events++; });
    await w.connectSimulator({ dut: "antenna" });
    const st = w.setStimulus({ start: 400e6, stop: 470e6, points: 51 });
    const d = await w.sweep();
    off();
    await w.sweep();
    w.setMarker(0, 435e6);
    return { st, n: d.length, events, f0: d[0].f, markers: w.markers().length, trace: w.trace(0).values.length, ts: w.exportTouchstone(1, "RI").split("\n").length, bad: await w.setState({ start: 1, bogus: 1 } as never).catch((e: Error) => e.message) };
  });
  expect(r.st.points).toBe(51);
  expect(r.n).toBe(51);
  expect(r.events).toBe(1);
  expect(r.f0).toBe(400e6);
  expect(r.markers).toBeGreaterThan(0);
  expect(r.trace).toBe(51);
  expect(r.ts).toBeGreaterThan(51);
  expect(r.bad).toContain("Not allowed");
});

test("every sidebar tab opens; language switches to Ukrainian and back", async ({ page }) => {
  await openApp(page);
  await connectSim(page);
  await sweepUi(page);
  const names = ["Stimulus", "Calibrate", "Display", "Markers", "Measure", "Device", "Files", "Script"];
  for (const n of names) {
    await tab(page, n);
    await expect(page.getByRole("tab", { name: n, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".panel .section").first()).toBeVisible();
  }
  const lang = page.getByRole("combobox", { name: "Language" }).first();
  await lang.selectOption("uk");
  await expect(page.locator("html")).toHaveAttribute("lang", "uk");
  for (const n of ["Stimulus", "Calibrate", "Display", "Markers", "Measure", "Device", "Files", "Script"]) {
    await page.locator("nav.tabs button[role=tab]").nth(names.indexOf(n)).click();
    await expect(page.locator(".panel .section").first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Відключити" })).toBeVisible();
  await page.getByRole("combobox", { name: /Мова|Language/ }).first().selectOption("en");
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
});

test("Measure statistics mode shows values", async ({ page }) => {
  await openApp(page);
  await apiSweep(page);
  await tab(page, "Measure");
  await page.getByRole("combobox", { name: "Measurement" }).selectOption("stats");
  const box = page.locator(".box", { has: page.getByRole("heading", { name: /^Analysis/ }) });
  await expect(box).toContainText("Std deviation");
  await expect(box).toContainText("Peak-to-peak");
  await expect(box).not.toContainText("NaN");
});
