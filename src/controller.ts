// Device control and data flow: connect, sweep, calibrate, markers, memories, files.
import { planSegments, AbortError, type SweepPoint } from "./lib/litevna";
import { MockLink } from "./lib/mock";
import { MockShellLink } from "./lib/mock-shell";
import { MockLibreLink } from "./lib/mock-libre";
import { LibreVNA } from "./lib/librevna";
import { LIBRE_USB_IDS } from "./lib/libre-protocol";
import type { VnaDriver } from "./lib/driver";
import { createDriver } from "./lib/detect";
import { clampPoints } from "./caps";
import { SerialLink, UsbLink, WebUsbBulkLink, type LinkBase } from "./lib/links";
import { DATA_MODE, USB_IDS, USB_IDS_V1 } from "./lib/protocol";
import { computeErrorTerms, parseCal, serializeCal, standardFromTouchstone, type CalData, type Standard } from "./lib/calibration";
import { averageSweeps } from "./lib/averaging";
import type { GateSettings } from "./lib/gating";
import { NO_FIXTURE, applyFixture, type FixtureSettings } from "./lib/deembed";
import { processData } from "./process";
import { timeDomain, strongestPeak } from "./lib/tdr";
import { parseLimits, serializeLimits } from "./lib/limits";
import { FORMAT_BY_ID, traceValues } from "./lib/formats";
import { nearestIndex, search } from "./lib/analysis";
import { combineFlip, fakeFlip } from "./lib/twoport";
import { parseTouchstone, writeCsv, writeTouchstone } from "./lib/touchstone";
import { get, log, set, updateTrace, TRACE_COLORS, type MemorySlot, type State } from "./store";
import { tr } from "./i18n";

let vna: VnaDriver | null = null;
let link: LinkBase | null = null;
let abort: AbortController | null = null;

export const hasWebSerial = () => typeof navigator !== "undefined" && "serial" in navigator;
export const hasWebUsb = () => typeof navigator !== "undefined" && "usb" in navigator;
export const isSimulator = () => link instanceof MockLink || link instanceof MockShellLink || link instanceof MockLibreLink;
const ALL_USB_IDS = [...USB_IDS, ...USB_IDS_V1];
export const BT_SPP = "00001101-0000-1000-8000-00805f9b34fb";

/** Listeners notified after every completed sweep (used by the scripting API). */
const sweepListeners = new Set<() => void>();
export function onSweepComplete(cb: () => void) { sweepListeners.add(cb); return () => { sweepListeners.delete(cb); }; }

const hex = (b: Uint8Array, max = 48) =>
  Array.from(b.slice(0, max), (x) => x.toString(16).padStart(2, "0")).join(" ") + (b.length > max ? ` … (${b.length} bytes)` : "");

function errMsg(e: unknown) { return e instanceof Error ? e.message : String(e); }

/* ------------------------------------------------------------------ connection */

async function attach(l: LinkBase, driver?: VnaDriver) {
  link = l;
  l.trace = (dir, bytes) => { if (get().commsMonitor) log(`${dir === "tx" ? "→" : "←"} ${hex(bytes)}`, "comms"); };
  l.onClose = () => {
    if (link !== l) return;
    log(tr("The device was disconnected."), "error");
    stop();
    vna = null; link = null;
    set({ status: "disconnected", info: null, capabilities: null, linkKind: "", running: false });
  };
  try {
    vna = driver ?? await createDriver(l);
    const info = await vna.init();
    const caps = vna.capabilities;
    set({ status: "connected", info, capabilities: caps, linkKind: l.kind, serial: "", vbat: null });
    if (caps.protocol === "v1-shell") log(tr("Connected via {0}: {1}, firmware {2} (experimental NanoVNA V1/H/H4 text protocol).", l.kind, info.model, info.firmware ?? "?"));
    else if (caps.protocol === "libre") log(tr("Connected via {0}: {1}, firmware {2} (experimental LibreVNA protocol).", l.kind, info.model, info.firmware ?? "?"));
    else log(tr("Connected via {0}: {1}, hw rev {2}, firmware {3}.{4}", l.kind, info.model, info.hardware, info.fwMajor, info.fwMinor));
    if (info.maxPoints === 0) throw new Error(tr("The device is in DFU/bootloader mode. Restart it normally."));
    const s = get();
    if (s.points > caps.maxPoints) set({ points: clampPoints(s.points, caps) });
    await applyDeviceSettings();
    if (caps.serial && vna.readSerial) { try { set({ serial: await vna.readSerial() }); } catch { /* optional */ } }
    await readVbat(true);
  } catch (e) {
    log(tr("Connection failed: {0}", errMsg(e)), "error");
    await l.close();
    vna = null; link = null;
    set({ status: "disconnected", info: null, capabilities: null, linkKind: "" });
    throw e;
  }
}

export async function connectSerial(port?: SerialPort, bluetooth = false) {
  if (!hasWebSerial()) { log(tr("Web Serial isn't available. Use Chrome or Edge on desktop over https or localhost."), "error"); return; }
  await disconnect();
  set({ status: "connecting" });
  try {
    const p = port ?? (await navigator.serial.requestPort(
      bluetooth
        // Chrome on Android: Bluetooth RFCOMM (SPP) serial; the type definitions may lack these fields.
        ? ({ allowedBluetoothServiceClassIds: [BT_SPP], filters: [{ bluetoothServiceClassId: BT_SPP }] } as unknown as SerialPortRequestOptions)
        : { filters: ALL_USB_IDS }));
    const l = new SerialLink();
    await l.open(p);
    await attach(l);
  } catch (e) {
    set({ status: "disconnected" });
    if ((e as Error)?.name !== "NotFoundError") log(tr("Web Serial: {0}", errMsg(e)), "error");
  }
}

/** Reconnect to a port the user already granted (no chooser). */
export async function reconnectKnown(): Promise<boolean> {
  if (!hasWebSerial()) return false;
  const ports = await navigator.serial.getPorts();
  const p = ports.find((x) => { const i = x.getInfo(); return ALL_USB_IDS.some((u) => u.usbVendorId === i.usbVendorId && u.usbProductId === i.usbProductId); });
  if (!p) return false;
  await connectSerial(p);
  return get().status === "connected";
}

/** Pair and connect a NanoVNA with a Bluetooth serial module (Web Serial over RFCOMM). */
export const connectBluetooth = () => connectSerial(undefined, true);

export async function connectUsb() {
  if (!hasWebUsb()) { log(tr("WebUSB isn't available in this browser."), "error"); return; }
  await disconnect();
  set({ status: "connecting" });
  try {
    const dev = await navigator.usb.requestDevice({ filters: [...ALL_USB_IDS, ...LIBRE_USB_IDS].map((u) => ({ vendorId: u.usbVendorId, productId: u.usbProductId })) });
    if (LIBRE_USB_IDS.some((u) => u.usbVendorId === dev.vendorId && u.usbProductId === dev.productId)) {
      // LibreVNA is recognised by its USB ids, not by probing bytes.
      const l = new WebUsbBulkLink();
      await l.open(dev);
      await attach(l, new LibreVNA(l));
    } else {
      const l = new UsbLink();
      await l.open(dev);
      await attach(l);
    }
  } catch (e) {
    set({ status: "disconnected" });
    if ((e as Error)?.name !== "NotFoundError") log(tr("WebUSB: {0}", errMsg(e)), "error");
  }
}

export async function connectSimulator() {
  await disconnect();
  const { simModel, simDut } = get();
  const m = simModel === "litevna" ? new MockLink()
    : simModel === "librevna" ? new MockLibreLink()
    : new MockShellLink({ board: simModel === "nanovna-h4" ? "H4" : "H", firmware: simModel === "nanovna-stock" ? "stock" : "D" });
  m.dut = simDut;
  await attach(m, m instanceof MockLibreLink ? new LibreVNA(m) : undefined);
}

export async function disconnect() {
  stop();
  const l = link, v = vna;
  if (!l) return;
  link = null; vna = null;
  try { if (v && !isSimulatorLink(l)) await v.exitUsbMode(); } catch { /* ignore */ }
  await l.close();
  set({ status: "disconnected", info: null, capabilities: null, linkKind: "", running: false });
  log(tr("Disconnected. The device screen is back in control."));
}

const isSimulatorLink = (l: LinkBase | null): l is MockLink | MockShellLink | MockLibreLink =>
  l instanceof MockLink || l instanceof MockShellLink || l instanceof MockLibreLink;

export function setSimDut(d: MockLink["dut"]) {
  set({ simDut: d });
  if (isSimulatorLink(link)) link.dut = d;
}

export function setSimModel(m: State["simModel"]) {
  const wasSim = isSimulator();
  set({ simModel: m });
  if (wasSim) void connectSimulator(); // reconnect with the new model
}

/* ------------------------------------------------------------------ device settings */

export async function applyDeviceSettings() {
  if (!vna) return;
  const s = get();
  try {
    const c = vna.capabilities;
    if (c.ifAverage) await vna.setAverage?.(s.ifAverage);
    if (c.power) await vna.setPower?.({ hf: s.powerHf, lf: s.powerLf });
    if (c.channels) await vna.setChannels?.(s.channelsMode);
    if (c.deviceCal) await vna.setDataMode?.(s.deviceCal ? DATA_MODE.DEVICE_CAL : DATA_MODE.USB);
    // unsupported: just don't apply it; the persisted preference is kept for devices that have the capability
  } catch (e) { log(tr("Device settings: {0}", errMsg(e)), "error"); }
}

export async function setIfAverage(n: number) { set({ ifAverage: n }); if (vna?.capabilities.ifAverage) await vna.setAverage?.(n).catch((e) => log(errMsg(e), "error")); }
export async function setPower(p: { hf?: number; lf?: number }) {
  set({ ...(p.hf != null ? { powerHf: p.hf } : {}), ...(p.lf != null ? { powerLf: p.lf } : {}) });
  if (vna?.capabilities.power) await vna.setPower?.(p).catch((e) => log(errMsg(e), "error"));
}
export async function setChannelsMode(mode: number) { set({ channelsMode: mode }); if (vna?.capabilities.channels) await vna.setChannels?.(mode).catch((e) => log(errMsg(e), "error")); }
export async function setDeviceCal(on: boolean) {
  if (on && vna && !vna.capabilities.deviceCal) { log(tr("This device can't deliver its own calibrated data."), "error"); return; }
  set({ deviceCal: on });
  if (vna?.capabilities.deviceCal) await vna.setDataMode?.(on ? DATA_MODE.DEVICE_CAL : DATA_MODE.USB).catch((e) => log(errMsg(e), "error"));
  log(on ? tr("Using the calibration stored in the device (data mode 3).") : tr("Using raw data (data mode 0)."));
}

export async function readVbat(quiet = false) {
  if (!vna?.capabilities.battery || !vna.readVbat) return;
  try {
    const v = await vna.readVbat();
    set({ vbat: v });
    if (!quiet) log(tr("Battery: {0} V", v.toFixed(3)));
  } catch (e) { if (!quiet) log(tr("Battery: {0}", errMsg(e)), "error"); }
}

export async function syncClock() {
  if (!vna?.capabilities.clock || !vna.setTime) return;
  try { await vna.setTime(); log(tr("Device clock set to {0}.", new Date().toLocaleString())); }
  catch (e) { log(tr("Clock: {0}", errMsg(e)), "error"); }
}

export async function screenshot() {
  if (!vna?.capabilities.screenshot || !vna.screenshot) return;
  const wasRunning = get().continuous;
  if (wasRunning) stop();
  try {
    log(tr("Capturing device screen…"));
    const shot = await vna.screenshot();
    const cv = document.createElement("canvas");
    cv.width = shot.width; cv.height = shot.height;
    cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(shot.rgba), shot.width, shot.height), 0, 0);
    set({ screenshot: { width: shot.width, height: shot.height, url: cv.toDataURL("image/png") } });
    log(tr("Screenshot {0}×{1}", shot.width, shot.height));
  } catch (e) { log(tr("Screenshot: {0}", errMsg(e)), "error"); }
  if (wasRunning) startContinuous();
}

export function getStats() { return vna?.stats ?? null; }

/* ------------------------------------------------------------------ sweeping */

function segments() {
  const s = get();
  return planSegments(s.start, s.stop, s.points, s.sweepMode, s.cwFreq);
}

async function acquire(): Promise<SweepPoint[]> {
  if (!vna) throw new Error(tr("Not connected."));
  const s = get();
  const n = Math.max(1, s.swAverage);
  const sweeps: SweepPoint[][] = [];
  abort = new AbortController();
  for (let k = 0; k < n; k++) {
    sweeps.push(await vna.sweepSegments(segments(), {
      signal: abort.signal,
      onProgress: (p) => set({ progress: (k + p) / n }),
    }, 1024));
  }
  return n === 1 ? sweeps[0] : averageSweeps(sweeps, s.swDiscard);
}

async function sweepCycle() {
  const t0 = performance.now();
  const raw = await acquire();
  if (get().frozen) return;
  set((s) => ({ raw, sweepCount: s.sweepCount + 1, lastSweepMs: performance.now() - t0, progress: 1 }));
  recompute();
  for (const cb of [...sweepListeners]) { try { cb(); } catch { /* listener errors must not break sweeping */ } }
  if (get().autoSave) await autoSaveSweep();
}

export async function sweepOnce() {
  if (!vna || get().running) return;
  set({ running: true, progress: 0 });
  try { await sweepCycle(); }
  catch (e) { if (!(e instanceof AbortError)) log(tr("Sweep failed: {0}", errMsg(e)), "error"); }
  finally { set({ running: false }); }
}

export async function startContinuous() {
  if (!vna || get().running) return;
  set({ running: true, continuous: true, progress: 0 });
  while (get().continuous && vna) {
    try { await sweepCycle(); }
    catch (e) {
      if (e instanceof AbortError && get().continuous) continue; // stimulus changed: restart the sweep
      if (!(e instanceof AbortError)) log(tr("Sweep failed: {0}", errMsg(e)), "error");
      break;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  set({ running: false, continuous: false });
}

export function stop() {
  set({ continuous: false });
  abort?.abort();
}

/** Restart continuous sweeping after a stimulus change. */
export function restartIfRunning() {
  if (get().continuous) { abort?.abort(); }
}

/* ------------------------------------------------------------------ processing */

export function recompute() {
  const s = get();
  let data: SweepPoint[];
  try { data = processData(s.raw, s); }
  catch (e) {
    // an unusable fixture stage must not blank the display: show the data without fixture and say why
    log(tr("Fixture: {0}", errMsg(e)), "error");
    data = processData(s.raw, { ...s, fixture: NO_FIXTURE });
  }
  set({ data });
  updateMarkers();
}

export function updateMarkers() {
  const s = get();
  const d = s.data;
  if (!d.length) return;
  const f0 = d[0].f, f1 = d[d.length - 1].f;
  let changed = false;
  const markers = s.markers.map((m) => {
    if (!m.enabled) return m;
    let f = m.f;
    if (!(f >= f0 && f <= f1)) f = d[Math.floor(d.length / 2)].f;
    if (m.tracking) {
      const t = s.traces[m.trace] ?? s.traces[0];
      const fmt = FORMAT_BY_ID[t.format].circular ? "logmag" : t.format;
      const v = traceValues(d, t.channel, fmt, { core: s.core });
      // For left/right modes start one step "behind" so a marker already on a peak stays there.
      const cur = nearestIndex(d, f);
      const from = m.tracking.endsWith("left") ? Math.min(d.length - 1, cur + 1) : m.tracking.endsWith("right") ? Math.max(0, cur - 1) : cur;
      const i = search(v, m.tracking, from);
      f = d[i].f;
    }
    if (f !== m.f) { changed = true; return { ...m, f }; }
    return m;
  });
  if (changed) set({ markers });
}

/** Change gate settings and re-process the current sweep. */
export function setGate(patch: Partial<GateSettings>) {
  set((s) => ({ gate: { ...s.gate, ...patch } }));
  recompute();
}

/** Centre the gate on the strongest time-domain response of the (ungated) calibrated data. */
export function gateAroundPeak() {
  const s = get();
  const ch = s.gate.channel === "s21" ? "s21" : "s11";
  const raw = processData(s.raw, { ...s, gate: { ...s.gate, enabled: false } });
  const r = timeDomain(raw, ch, { ...s.tdr, mode: "bandpass", yAxis: "linear", window: "normal" });
  if (!r) { log(tr("Sweep first: the time-domain transform needs data."), "error"); return; }
  setGate({ center: r.time[strongestPeak(r)] });
}

/* ------------------------------------------------------------------ calibration */

export async function measureStandard(std: Standard) {
  if (!vna) { log(tr("Connect a device (or the simulator) first."), "error"); return; }
  const wasRunning = get().continuous;
  stop();
  while (get().running) await new Promise((r) => setTimeout(r, 20));
  if (isSimulatorLink(link)) link.dut = std === "isolation" ? "isolation" : std;
  set({ running: true, progress: 0 });
  try {
    if (get().deviceCal && vna.capabilities.deviceCal) await setDeviceCal(false);
    log(tr("Measuring {0}…", tr(std.toUpperCase())));
    const d = await acquire();
    const freqs = d.map((p) => p.f);
    set((s) => {
      const same = s.calWork.freqs && s.calWork.freqs.length === freqs.length && s.calWork.freqs.every((f, i) => f === freqs[i]);
      const base = same ? s.calWork : { freqs, meas: {}, thru11: null };
      return {
        calWork: {
          freqs,
          meas: { ...base.meas, [std]: d.map((p) => (std === "thru" || std === "isolation" ? p.s21 : p.s11)) },
          thru11: std === "thru" ? d.map((p) => p.s11) : base.thru11,
        },
      };
    });
    log(tr("{0} measured ({1} points).", tr(std.toUpperCase()), freqs.length));
  } catch (e) { if (!(e instanceof AbortError)) log(tr("Calibration sweep failed: {0}", errMsg(e)), "error"); }
  finally {
    set({ running: false });
    if (isSimulatorLink(link)) link.dut = get().simDut;
  }
  if (wasRunning) void startContinuous();
}

export function finishCalibration(name = `Cal ${new Date().toLocaleString()}`) {
  const s = get();
  const w = s.calWork;
  if (!w.freqs) { log(tr("Measure the standards first."), "error"); return; }
  const m = w.meas;
  const hasSol = m.open && m.short && m.load;
  if (!hasSol && !m.open && !m.short && !m.thru) { log(tr("Measure at least OPEN, SHORT and LOAD (or THRU)."), "error"); return; }
  const cal: CalData = {
    name, created: new Date().toISOString(), freqs: w.freqs, kit: s.kit, enhancedResponse: s.enhancedResponse && !!hasSol && !!m.thru,
    open: m.open, short: m.short, load: m.load, isolation: m.isolation, thru: m.thru, thru11: w.thru11 ?? undefined,
  };
  setCalibration(cal);
  log(tr("Calibration applied: {0}{1}.", Object.keys(m).map((k) => tr(k.toUpperCase())).join(", "), cal.enhancedResponse ? ` + ${tr("enhanced response")}` : ""));
}

const ACTIVE_CAL = "webvna.activecal";
export function setCalibration(cal: CalData | null) {
  set({ cal, terms: cal ? computeErrorTerms(cal) : null, calEnabled: true });
  try { if (cal) localStorage.setItem(ACTIVE_CAL, serializeCal(cal)); else localStorage.removeItem(ACTIVE_CAL); } catch { /* storage full or unavailable */ }
  recompute();
}

/** Restore the calibration that was active when the page was last closed. */
export function restoreActiveCal() {
  try {
    const t = localStorage.getItem(ACTIVE_CAL);
    if (!t) return;
    const cal = parseCal(t);
    set({ cal, terms: computeErrorTerms(cal) });
    log(tr("Restored calibration: {0}", cal.name));
  } catch { /* ignore */ }
}

/** Attach a measured Touchstone file (S11) as the data of an open/short/load standard. */
export async function attachStandardFile(std: "open" | "short" | "load", file: File) {
  try {
    const sd = standardFromTouchstone(await file.text(), file.name);
    set((s) => ({ kit: { ...s.kit, name: "Custom", data: { ...s.kit.data, [std]: sd } } }));
    refreshCalTerms();
    log(tr("{0} standard: {1} ({2} points).", tr(std.toUpperCase()), file.name, sd.freqs.length));
  } catch (e) { log(tr("Import {0}: {1}", file.name, errMsg(e)), "error"); }
}
export function detachStandard(std: "open" | "short" | "load") {
  set((s) => {
    const kit = { ...s.kit, name: "Custom" }, data = { ...kit.data };
    delete data[std];
    if (Object.keys(data).length) kit.data = data; else delete kit.data;
    return { kit };
  });
  refreshCalTerms();
}

export function clearCalWork() { set({ calWork: { freqs: null, meas: {}, thru11: null } }); }
export function resetCalibration() { setCalibration(null); clearCalWork(); log(tr("Calibration cleared. Readings are raw.")); }

/** Recompute error terms after changing the cal kit / enhanced response. */
export function refreshCalTerms() {
  const s = get();
  if (!s.cal) return;
  setCalibration({ ...s.cal, kit: s.kit, enhancedResponse: s.enhancedResponse && !!s.cal.thru && !!s.cal.open });
}

export function stimulusFromCal() {
  const c = get().cal;
  if (!c) return;
  set({ start: c.freqs[0], stop: c.freqs[c.freqs.length - 1], points: c.freqs.length, sweepMode: "linear" });
  restartIfRunning();
}

const CAL_PREFIX = "webvna.cal.";
export function listCalSlots(): string[] {
  const out: string[] = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith(CAL_PREFIX)) out.push(k.slice(CAL_PREFIX.length)); } }
  catch { /* storage unavailable */ }
  return out.sort();
}
export function saveCalSlot(name: string) {
  const c = get().cal;
  if (!c) { log(tr("No calibration to save."), "error"); return; }
  try { localStorage.setItem(CAL_PREFIX + name, serializeCal({ ...c, name })); log(tr("Calibration saved as \"{0}\".", name)); }
  catch (e) { log(tr("Couldn't save calibration: {0}", errMsg(e)), "error"); }
}
export function loadCalSlot(name: string) {
  try {
    const t = localStorage.getItem(CAL_PREFIX + name);
    if (!t) return;
    const cal = parseCal(t);
    set({ kit: cal.kit, enhancedResponse: cal.enhancedResponse });
    setCalibration(cal);
    log(tr("Calibration \"{0}\" loaded.", name));
  } catch (e) { log(tr("Couldn't load calibration: {0}", errMsg(e)), "error"); }
}
export function deleteCalSlot(name: string) { try { localStorage.removeItem(CAL_PREFIX + name); } catch { /* ignore */ } }

/* ------------------------------------------------------------------ fixture */

/** Replace the fixture settings and re-process the current sweep. */
export function setFixture(fixture: FixtureSettings) {
  set({ fixture });
  recompute();
}

/* ------------------------------------------------------------------ two-port by flipping the DUT */

/** Simulator only: present the DUT reversed (port 1 sees DUT port 2). */
export function setSimReversed(on: boolean) { if (isSimulatorLink(link)) link.reversed = on; }

/** Acquire a RAW sweep of the DUT in one orientation (forward, or reversed after the user turned it around). */
export async function measureFlip(dir: "fwd" | "rev") {
  if (!vna) { log(tr("Connect a device (or the simulator) first."), "error"); return; }
  stop();
  while (get().running) await new Promise((r) => setTimeout(r, 20));
  if (isSimulatorLink(link)) { link.dut = get().simDut; link.reversed = dir === "rev"; }
  set({ running: true, progress: 0 });
  try {
    const d = await acquire();
    set((s) => ({ twoPort: { ...s.twoPort, [dir]: d, result: null } }));
    log(dir === "fwd" ? tr("Forward sweep measured ({0} points).", d.length) : tr("Reversed sweep measured ({0} points).", d.length));
  } catch (e) { if (!(e instanceof AbortError)) log(tr("Sweep failed: {0}", errMsg(e)), "error"); }
  finally {
    if (isSimulatorLink(link)) link.reversed = false;
    set({ running: false });
  }
}

/** Combine the forward and reversed sweeps (cal + fixture applied) into full S-parameters. */
export function buildFlip() {
  const s = get();
  const { fwd, rev } = s.twoPort;
  if (!fwd || !rev) { log(tr("Measure both orientations first."), "error"); return; }
  try {
    const terms = s.calEnabled && !(s.deviceCal && s.capabilities?.deviceCal !== false) ? s.terms : null;
    const result = applyFixture(combineFlip(fwd, rev, terms), s.fixture);
    set({ twoPort: { fwd, rev, result } });
    log(tr("Full 2-port S-parameters built ({0} points).", result.length));
  } catch (e) { log(tr("2-port: {0}", errMsg(e)), "error"); }
}

/** Assume a symmetric reciprocal DUT: S12 = S21, S22 = S11 of the current (corrected) sweep. */
export function fakeFlipCurrent() {
  const d = get().data;
  if (!d.length) { log(tr("Nothing to use yet: sweep first."), "error"); return; }
  set((s) => ({ twoPort: { ...s.twoPort, result: fakeFlip(d) } }));
  log(tr("Assumed a symmetric DUT: S12 = S21, S22 = S11."));
}

export function clearTwoPort() { set({ twoPort: { fwd: null, rev: null, result: null } }); }

export function exportFull2Port(fmt: "RI" | "MA" | "DB" = "RI") {
  const r = get().twoPort.result;
  if (!r) { log(tr("Build the 2-port S-parameters first."), "error"); return; }
  const name = `${get().autoSaveName || "webvna"}-2port-${stamp()}.s2p`;
  download(name, writeTouchstone(r, 2, `WebVNA ${get().info?.model ?? ""} full 2-port (flip DUT)`, fmt));
  log(tr("Saved {0}", name));
}

export function flipAsOverlay() {
  const r = get().twoPort.result;
  if (!r) { log(tr("Build the 2-port S-parameters first."), "error"); return; }
  set((s) => ({ refs: [...s.refs, { name: "2-port", data: r, ports: 2, visible: true, color: TRACE_COLORS[(s.refs.length + 2) % 4] }] }));
  log(tr("Added the 2-port result as an overlay (Display tab)."));
}

/* ------------------------------------------------------------------ memories and references */

export function storeMemory(slot: MemorySlot) {
  const d = get().data;
  if (!d.length) { log(tr("Nothing to store yet: sweep first."), "error"); return; }
  set((s) => ({ memories: { ...s.memories, [slot]: d.map((p) => ({ ...p })) } }));
  log(tr("Trace stored in memory {0}.", slot));
}
export function clearMemory(slot: MemorySlot) { set((s) => { const m = { ...s.memories }; delete m[slot]; return { memories: m }; }); }

export async function importTouchstoneFile(file: File) {
  try {
    const t = parseTouchstone(await file.text(), file.name);
    set((s) => ({ refs: [...s.refs, { name: file.name, data: t.data, ports: t.ports, visible: true, color: TRACE_COLORS[(s.refs.length + 2) % 4] }] }));
    log(tr("Loaded {0}: {1} points, {2}-port.", file.name, t.data.length, t.ports));
  } catch (e) { log(tr("Import {0}: {1}", file.name, errMsg(e)), "error"); }
}

export async function importCalFile(file: File) {
  try {
    const cal = parseCal(await file.text());
    set({ kit: cal.kit, enhancedResponse: cal.enhancedResponse });
    setCalibration(cal);
    log(tr("Calibration loaded from {0}.", file.name));
  } catch (e) { log(tr("Import {0}: {1}", file.name, errMsg(e)), "error"); }
}

/* ------------------------------------------------------------------ limits */

export function exportLimits(trace: number) {
  const segs = get().traces[trace]?.limits ?? [];
  if (!segs.length) { log(tr("No limits to save."), "error"); return; }
  download(`webvna-limits-TR${trace + 1}.json`, serializeLimits(segs), "application/json");
}
export async function importLimitsFile(trace: number, file: File) {
  try {
    const segs = parseLimits(await file.text());
    updateTrace(trace, { limits: segs });
    log(tr("Loaded {0}: {1} limit segments.", file.name, segs.length));
  } catch (e) { log(tr("Import {0}: {1}", file.name, errMsg(e)), "error"); }
}

/* ------------------------------------------------------------------ files */

export function download(name: string, content: string | Blob, type = "text/plain") {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);

export function exportData(kind: "s1p" | "s2p" | "csv", fmt: "RI" | "MA" | "DB" = "RI") {
  const d = get().data;
  if (!d.length) { log(tr("Nothing to export yet: sweep first."), "error"); return; }
  const name = `${get().autoSaveName || "webvna"}-${stamp()}.${kind}`;
  const comment = `WebVNA ${get().info?.model ?? ""} ${get().cal ? "calibrated" : "raw"}`;
  download(name, kind === "csv" ? writeCsv(d) : writeTouchstone(d, kind === "s1p" ? 1 : 2, comment, fmt));
  log(tr("Saved {0}", name));
}

export function exportCal() {
  const c = get().cal;
  if (!c) { log(tr("No calibration to export."), "error"); return; }
  download(`webvna-cal-${stamp()}.json`, serializeCal(c), "application/json");
}

let dirHandle: FileSystemDirectoryHandle | null = null;
type DirPicker = { showDirectoryPicker?: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle> };

export async function chooseAutoSaveDir(): Promise<boolean> {
  const w = window as unknown as DirPicker;
  if (!w.showDirectoryPicker) { log(tr("This browser can't write to a folder; each sweep will be downloaded instead."), "error"); return true; }
  try { dirHandle = await w.showDirectoryPicker({ mode: "readwrite" }); log(tr("Auto-save folder: {0}", dirHandle.name)); return true; }
  catch { return false; }
}

async function autoSaveSweep() {
  const s = get();
  const ports = s.channelsMode === 1 ? 1 : 2;
  const name = `${s.autoSaveName || "sweep"}-${stamp()}-${s.sweepCount}.s${ports}p`;
  const text = writeTouchstone(s.data, ports as 1 | 2, `WebVNA auto-save #${s.sweepCount}`);
  try {
    if (dirHandle) {
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
    } else download(name, text);
  } catch (e) { log(tr("Auto-save: {0}", errMsg(e)), "error"); }
}
