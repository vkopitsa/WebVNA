import { readFile } from "node:fs/promises";
import { test, expect, tab, openApp, connectSim, apiSweep } from "./fixtures.ts";

const analysis = (page: import("@playwright/test").Page) => page.locator(".box", { has: page.getByRole("heading", { name: /^Analysis/ }) });

test("limit lines: SWR upper limit from the band gives PASS and FAIL", async ({ page }) => {
  await openApp(page);
  await apiSweep(page, { dut: "antenna" });
  await tab(page, "Display");
  await page.getByRole("combobox", { name: "Trace 1 format" }).selectOption("swr");
  await page.getByRole("spinbutton", { name: "New limit value" }).fill("1.01");
  await page.getByRole("button", { name: "From current band" }).click();
  await expect(page.getByRole("button", { name: "Delete segment 1" })).toBeVisible();
  await expect(analysis(page)).toContainText("FAIL");
  expect(await page.evaluate(() => window.webvna.limits(0).pass)).toBe(false);
  // loosen the limit: PASS
  await page.getByRole("spinbutton", { name: "Limit value at start" }).fill("1000");
  await page.getByRole("spinbutton", { name: "Limit value at start" }).blur();
  await page.getByRole("spinbutton", { name: "Limit value at stop" }).fill("1000");
  await page.getByRole("spinbutton", { name: "Limit value at stop" }).blur();
  await expect(analysis(page)).toContainText("PASS");
  expect(await page.evaluate(() => window.webvna.limits().pass)).toBe(true);
  await page.getByRole("complementary", { name: "Settings" }).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByRole("button", { name: "Delete segment 1" })).toHaveCount(0);
});

test("TDR with zero padding and time gating", async ({ page }) => {
  await openApp(page);
  await apiSweep(page, { dut: "cable", start: 50e3, stop: 200e6, points: 201 });
  await tab(page, "Display");
  await page.getByRole("checkbox", { name: /Transform rectangular traces to time domain/ }).check();
  await page.getByRole("combobox", { name: "Zero padding" }).selectOption("4");
  await page.getByRole("combobox", { name: "Transform mode" }).selectOption("lowpass_step");
  await page.getByRole("combobox", { name: "Transform mode" }).selectOption("lowpass_impulse");
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.getByRole("checkbox", { name: /Gate the sweep in the time domain/ }).check();
  const centre = page.getByRole("textbox", { name: "Gate centre", exact: true });
  const c0 = await centre.inputValue();
  await page.getByRole("button", { name: "Gate around TDR peak" }).click();
  await expect(centre).not.toHaveValue(c0);
  await page.getByRole("combobox", { name: "Gate units" }).selectOption("m");
  await expect(page.getByRole("spinbutton", { name: "Gate centre in metres" })).toBeVisible();
  await page.getByRole("combobox", { name: "Gate type" }).selectOption("notch");
  await page.getByRole("checkbox", { name: /Transform rectangular traces to time domain/ }).uncheck();
  expect(await page.evaluate(() => window.webvna.data().length)).toBe(201);
});

test("µ′ and R/ω formats render values", async ({ page }) => {
  await openApp(page);
  await apiSweep(page, { dut: "rlc" });
  await tab(page, "Display");
  await page.getByRole("combobox", { name: "Trace 1 format" }).selectOption("mu_r");
  await expect(page.getByRole("heading", { name: /Core/ })).toBeVisible();
  await page.getByRole("checkbox", { name: "Trace 2 on" }).check();
  await page.getByRole("combobox", { name: "Trace 2 format" }).selectOption("rw");
  const mt = page.locator(".box", { has: page.getByRole("heading", { name: "Markers" }) });
  await expect(mt.locator("thead")).toContainText("µ′");
  await expect(mt.locator("thead")).toContainText("R/ω");
  const cells = await mt.locator("tbody tr").first().locator("td").allTextContents();
  expect(cells.length).toBeGreaterThanOrEqual(4);
  for (const c of cells.slice(2)) { expect(c).not.toMatch(/NaN|undefined/); expect(c.trim()).not.toBe(""); }
  const v = await page.evaluate(() => window.webvna.trace(0).values.every((x: number) => Number.isFinite(x) || Number.isNaN(x) || Math.abs(x) === Infinity));
  expect(v).toBe(true);
  await page.getByRole("spinbutton", { name: "Core turns" }).fill("5");
  await page.getByRole("spinbutton", { name: "Core turns" }).blur();
});

test("fixture de-embedding changes the data", async ({ page }) => {
  await openApp(page);
  await apiSweep(page, { dut: "antenna" });
  const before = await page.evaluate(() => window.webvna.data()[50].s11);
  await tab(page, "Calibrate");
  await page.getByRole("button", { name: "+ Lumped" }).first().click();
  await page.getByRole("checkbox", { name: "Apply fixture" }).check();
  await expect.poll(() => page.evaluate(() => window.webvna.data()[50].s11[0])).not.toBe(before[0]);
  // embed / edit the stage and remove it again
  await page.getByRole("combobox", { name: "Fixture operation" }).selectOption("embed");
  await page.getByRole("combobox", { name: "Lumped element" }).selectOption("C");
  await page.getByRole("button", { name: "Remove stage" }).click();
  await expect.poll(() => page.evaluate(() => window.webvna.data()[50].s11[0])).toBeCloseTo(before[0], 6);
});

test("flip-DUT 2-port wizard with the L-pad DUT exports .s2p", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await window.webvna.connectSimulator({ dut: "pad" });
    window.webvna.setStimulus({ start: 1e6, stop: 100e6, points: 51 });
  });
  await tab(page, "Calibrate");
  await page.getByRole("button", { name: "1. Measure forward" }).click();
  await expect(page.getByRole("button", { name: /✓ 1\. Measure forward/ })).toBeVisible();
  await page.getByRole("button", { name: /2\. Reverse the DUT and measure/ }).click();
  await expect(page.getByRole("button", { name: /✓ 2\. Reverse/ })).toBeVisible();
  await page.getByRole("button", { name: "Build S-parameters" }).click();
  await expect(page.getByText(/Result ready/)).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export .s2p" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/\.s2p$/);
  const text = await readFile(await dl.path(), "utf8");
  expect(text).toContain("# ");
  expect(text.split("\n").filter((l) => l && !l.startsWith("!") && !l.startsWith("#")).length).toBe(51);
  await page.getByRole("button", { name: "Show as overlay" }).click();
  await page.getByRole("complementary", { name: "Settings" }).getByRole("button", { name: "Clear", exact: true }).last().click();
  await expect(page.getByText("No result yet.")).toBeVisible();
});

test("session file round trip and share link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await apiSweep(page, { dut: "antenna", points: 51 });
  const orig = await page.evaluate(() => window.webvna.data());
  await tab(page, "Files");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save session" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/\.webvna\.json$/);
  const file = test.info().outputPath("session.webvna.json");
  await dl.saveAs(file);

  // share link
  await page.getByRole("button", { name: "Copy share link" }).click();
  await expect(page.getByText(/Link copied to the clipboard/)).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("#s=");

  // reload: no data; open the session file
  await page.reload();
  await expect(page.getByText("No data yet.")).toBeVisible();
  await tab(page, "Files");
  await page.locator('input[type=file][accept*="json"]').setInputFiles(file);
  await expect(page.getByText(/Session loaded: 51 points/)).toBeVisible();
  const back = await page.evaluate(() => window.webvna.data());
  expect(back.length).toBe(51);
  expect(back[10].s11[0]).toBeCloseTo(orig[10].s11[0], 9);

  // shared link in a fresh page
  const p2 = await context.newPage();
  const errs: string[] = [];
  p2.on("pageerror", (e) => errs.push(e.message));
  p2.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p2.goto(url);
  await expect(p2.getByText("Loaded shared measurement")).toBeVisible();
  expect(await p2.evaluate(() => window.webvna.data().length)).toBe(51);
  expect(p2.url()).not.toContain("#s=");
  expect(errs).toEqual([]);
  // a damaged link reports an error in the log, not an exception
  const p3 = await context.newPage();
  await p3.goto("/#s=AAAA");
  await expect(p3.getByText("The shared link is damaged.")).toBeVisible();
});

test("bad session file is rejected with a log message", async ({ page }) => {
  await openApp(page);
  await tab(page, "Files");
  await page.locator('input[type=file][accept*="json"]').setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{\"format\":\"nope\"}") });
  await expect(page.getByText(/Not a WebVNA session file/)).toBeVisible();
});

for (const [model, label] of [["nanovna-h", "NanoVNA-H"], ["nanovna-h4", "NanoVNA-H4"], ["nanovna-stock", "NanoVNA-H"], ["litevna", "LiteVNA"]] as const) {
  test(`simulator model ${model}: 201-point sweep`, async ({ page }) => {
    await openApp(page);
    await page.evaluate(async (m) => {
      await window.webvna.connectSimulator({ model: m as never, dut: "antenna" });
      window.webvna.setStimulus({ start: 1e6, stop: 100e6, points: 201 });
      await window.webvna.sweep();
    }, model);
    const st = await page.evaluate(() => ({ n: window.webvna.data().length, model: window.webvna.state().model }));
    expect(st.n).toBe(201);
    expect(st.model).toContain(label);
    await tab(page, "Device");
    await expect(page.getByRole("combobox", { name: "Simulated model" })).toHaveValue(model);
  });
}

test("Device tab: switch simulated model and DUT while connected", async ({ page }) => {
  await openApp(page);
  await connectSim(page);
  await tab(page, "Device");
  await page.getByRole("combobox", { name: "Simulated model" }).selectOption("nanovna-h4");
  await expect(page.getByText("Protocol", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Simulated DUT" }).selectOption("filter");
  await page.getByRole("button", { name: "Sweep", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.webvna.state().sweepCount)).toBeGreaterThan(0);
});

test("Script tab runs a script with print()", async ({ page }) => {
  await openApp(page);
  await tab(page, "Script");
  await page.getByRole("textbox", { name: "Script" }).fill(
    `await webvna.connectSimulator({ dut: "antenna" });\nwebvna.setStimulus({ start: 400e6, stop: 470e6, points: 51 });\nconst d = await webvna.sweep();\nprint("n=" + d.length);\nreturn { ok: true };`);
  await page.getByRole("button", { name: "Run script" }).click();
  const out = page.getByRole("log", { name: "Script output" });
  await expect(out).toContainText("n=51");
  await expect(out).toContainText("→");
  await expect(out).toContainText('"ok": true');
  // an error is shown, not thrown
  await page.getByRole("textbox", { name: "Script" }).fill("throw new Error('boom');");
  await page.getByRole("button", { name: "Run script" }).click();
  await expect(out).toContainText("boom");
  // the example script runs as well
  await page.getByRole("button", { name: "Example" }).click();
  await page.getByRole("button", { name: "Run script" }).click();
  await expect(out).toContainText("points: 101");
});
