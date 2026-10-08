// Device control and data flow: connect, sweep, calibrate, markers, memories, files.
import { LiteVNA, planSegments, AbortError, type SweepPoint } from "./lib/litevna";
import { MockLink } from "./lib/mock";
import { SerialLink, UsbLink, type LinkBase } from "./lib/links";
import { DATA_MODE, USB_IDS } from "./lib/protocol";
import { C } from "./lib/complex";
import { applyCalibration, computeErrorTerms, parseCal, serializeCal, type CalData, type Standard } from "./lib/calibration";
import { FORMAT_BY_ID, traceValues } from "./lib/formats";
import { nearestIndex, search } from "./lib/analysis";
import { parseTouchstone, writeCsv, writeTouchstone } from "./lib/touchstone";
import { ACTIVE_CAL_KEY, get, log, set, TRACE_COLORS, type MemorySlot } from "./store";
import { tr } from "./i18n";

let vna: LiteVNA | null = null;
let link: LinkBase | null = null;
let abort: AbortController | null = null;

export const hasWebSerial = () => typeof navigator !== "undefined" && "serial" in navigator;
export const hasWebUsb = () => typeof navigator !== "undefined" && "usb" in navigator;
export const isSimulator = () => link instanceof MockLink;

const hex = (b: Uint8Array, max = 48) =>
  Array.from(b.slice(0, max), (x) => x.toString(16).padStart(2, "0")).join(" ") + (b.length > max ? ` … (${b.length} bytes)` : "");

function errMsg(e: unknown) { return e instanceof Error ? e.message : String(e); }

/* ------------------------------------------------------------------ connection */

async function attach(l: LinkBase) {
  link = l;
  l.trace = (dir, bytes) => { if (get().commsMonitor) log(`${dir === "tx" ? "→" : "←"} ${hex(bytes)}`, "comms"); };
  l.onClose = () => {
    if (link !== l) return;
    log(tr("The device was disconnected."), "error");
    stop();
    vna = null; link = null;
    set({ status: "disconnected", info: null, linkKind: "", running: false });
  };
  vna = new LiteVNA(l);
  try {
    const info = await vna.init();
    set({ status: "connected", info, linkKind: l.kind });
    log(tr("Connected via {0}: {1}, hw rev {2}, firmware {3}.{4}", l.kind, info.model, info.hardware, info.fwMajor, info.fwMinor));
    if (info.maxPoints === 0) throw new Error(tr("The device is in DFU/bootloader mode. Restart it normally."));
    const s = get();
    if (s.points > info.maxPoints) set({ points: info.maxPoints });
    await applyDeviceSettings();
    try { set({ serial: await vna.readSerial() }); } catch { /* optional */ }
    await readVbat(true);
  } catch (e) {
    log(tr("Connection failed: {0}", errMsg(e)), "error");
    await l.close();
    vna = null; link = null;
    set({ status: "disconnected", info: null, linkKind: "" });
    throw e;
  }
}

export async function connectSerial(port?: SerialPort) {
  if (!hasWebSerial()) { log(tr("Web Serial isn't available. Use Chrome or Edge on desktop over https or localhost."), "error"); return; }
  await disconnect();
  set({ status: "connecting" });
  try {
    const p = port ?? (await navigator.serial.requestPort({ filters: USB_IDS }));
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
  const p = ports.find((x) => { const i = x.getInfo(); return USB_IDS.some((u) => u.usbVendorId === i.usbVendorId && u.usbProductId === i.usbProductId); });
  if (!p) return false;
  await connectSerial(p);
  return get().status === "connected";
}

export async function connectUsb() {
  if (!hasWebUsb()) { log(tr("WebUSB isn't available in this browser."), "error"); return; }
  await disconnect();
  set({ status: "connecting" });
  try {
    const dev = await navigator.usb.requestDevice({ filters: USB_IDS.map((u) => ({ vendorId: u.usbVendorId, productId: u.usbProductId })) });
    const l = new UsbLink();
    await l.open(dev);
    await attach(l);
  } catch (e) {
    set({ status: "disconnected" });
    if ((e as Error)?.name !== "NotFoundError") log(tr("WebUSB: {0}", errMsg(e)), "error");
  }
}

export async function connectSimulator() {
  await disconnect();
  const m = new MockLink();
  m.dut = get().simDut;
  await attach(m);
}

export async function disconnect() {
  stop();
  const l = link, v = vna;
  if (!l) return;
  link = null; vna = null;
  try { if (v && !(l instanceof MockLink)) await v.exitUsbMode(); } catch { /* ignore */ }
  await l.close();
  set({ status: "disconnected", info: null, linkKind: "", running: false });
  log(tr("Disconnected. The device screen is back in control."));
}

export function setSimDut(d: MockLink["dut"]) {
  set({ simDut: d });
  if (link instanceof MockLink) link.dut = d;
}

/* ------------------------------------------------------------------ device settings */

export async function applyDeviceSettings() {
  if (!vna) return;
  const s = get();
  try {
    await vna.setAverage(s.ifAverage);
    await vna.setPower({ hf: s.powerHf, lf: s.powerLf });
    await vna.setChannels(s.channelsMode);
    await vna.setDataMode(s.deviceCal ? DATA_MODE.DEVICE_CAL : DATA_MODE.USB);
  } catch (e) { log(tr("Device settings: {0}", errMsg(e)), "error"); }
}

export async function setIfAverage(n: number) { set({ ifAverage: n }); if (vna) await vna.setAverage(n).catch((e) => log(errMsg(e), "error")); }
export async function setPower(p: { hf?: number; lf?: number }) {
  set({ ...(p.hf != null ? { powerHf: p.hf } : {}), ...(p.lf != null ? { powerLf: p.lf } : {}) });
  if (vna) await vna.setPower(p).catch((e) => log(errMsg(e), "error"));
}
export async function setChannelsMode(mode: number) { set({ channelsMode: mode }); if (vna) await vna.setChannels(mode).catch((e) => log(errMsg(e), "error")); }
export async function setDeviceCal(on: boolean) {
  set({ deviceCal: on });
  if (vna) await vna.setDataMode(on ? DATA_MODE.DEVICE_CAL : DATA_MODE.USB).catch((e) => log(errMsg(e), "error"));
  log(on ? tr("Using the calibration stored in the device (data mode 3).") : tr("Using raw data (data mode 0)."));
}

export async function readVbat(quiet = false) {
  if (!vna) return;
  try {
    const v = await vna.readVbat();
    set({ vbat: v });
    if (!quiet) log(tr("Battery: {0} V", v.toFixed(3)));
  } catch (e) { if (!quiet) log(tr("Battery: {0}", errMsg(e)), "error"); }
}

export async function syncClock() {
  if (!vna) return;
  try { await vna.setTime(); log(tr("Device clock set to {0}.", new Date().toLocaleString())); }
  catch (e) { log(tr("Clock: {0}", errMsg(e)), "error"); }
}

export async function screenshot() {
  if (!vna) return;
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
  let acc: SweepPoint[] | null = null;
  abort = new AbortController();
  const segs = segments(); // snapshot: every averaging pass must sweep the same grid
  for (let k = 0; k < n; k++) {
    const d = await vna.sweepSegments(segs, {
      signal: abort.signal,
      onProgress: (p) => set({ progress: (k + p) / n }),
    }, 1024);
    if (!acc) acc = d.map((p) => ({ f: p.f, s11: [...p.s11] as typeof p.s11, s21: [...p.s21] as typeof p.s21 }));
    else for (let i = 0; i < d.length; i++) { acc[i].s11 = C.add(acc[i].s11, d[i].s11); acc[i].s21 = C.add(acc[i].s21, d[i].s21); }
  }
  if (n > 1) for (const p of acc!) { p.s11 = C.scale(p.s11, 1 / n); p.s21 = C.scale(p.s21, 1 / n); }
  return acc!;
}

async function sweepCycle() {
  const t0 = performance.now();
  const raw = await acquire();
  if (get().frozen) return;
  set((s) => ({ raw, sweepCount: s.sweepCount + 1, lastSweepMs: performance.now() - t0, progress: 1 }));
  recompute();
  if (get().autoSave) await autoSaveSweep();
}

export async function sweepOnce() {
  if (!vna || get().running) return;
  set({ running: true, progress: 0 });
  try { await sweepCycle(); }
  catch (e) { if (!(e instanceof AbortError) && vna) log(tr("Sweep failed: {0}", errMsg(e)), "error"); } // vna === null: disconnected mid-sweep
  finally { set({ running: false }); }
}

export async function startContinuous() {
  if (!vna || get().running) return;
  set({ running: true, continuous: true, progress: 0 });
  while (get().continuous && vna) {
    try { await sweepCycle(); }
    catch (e) {
      if (e instanceof AbortError && get().continuous) continue; // stimulus changed: restart the sweep
      if (!(e instanceof AbortError) && vna) log(tr("Sweep failed: {0}", errMsg(e)), "error");
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
  const terms = s.calEnabled ? s.terms : null;
  const data = s.raw.length ? applyCalibration(s.raw, terms, s.correction) : [];
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
      const v = traceValues(d, t.channel, fmt);
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

/* ------------------------------------------------------------------ calibration */

export async function measureStandard(std: Standard) {
  if (!vna) { log(tr("Connect a device (or the simulator) first."), "error"); return; }
  const wasRunning = get().continuous;
  stop();
  while (get().running) await new Promise((r) => setTimeout(r, 20));
  if (isSimulator()) (link as MockLink).dut = std === "isolation" ? "isolation" : std;
  set({ running: true, progress: 0 });
  try {
    if (get().deviceCal) await setDeviceCal(false);
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
    if (isSimulator()) (link as MockLink).dut = get().simDut;
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

export function setCalibration(cal: CalData | null) {
  set({ cal, terms: cal ? computeErrorTerms(cal) : null, calEnabled: true });
  try { if (cal) localStorage.setItem(ACTIVE_CAL_KEY, serializeCal(cal)); else localStorage.removeItem(ACTIVE_CAL_KEY); } catch { /* storage full or unavailable */ }
  recompute();
}

/** Restore the calibration that was active when the page was last closed. */
export function restoreActiveCal() {
  try {
    const t = localStorage.getItem(ACTIVE_CAL_KEY);
    if (!t) return;
    const cal = parseCal(t);
    set({ cal, terms: computeErrorTerms(cal) });
    log(tr("Restored calibration: {0}", cal.name));
  } catch { /* ignore */ }
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
    setCalibration(cal); // computes the terms first: a kit that fails never reaches the store
    set({ kit: cal.kit, enhancedResponse: cal.enhancedResponse });
    log(tr("Calibration \"{0}\" loaded.", name));
  } catch (e) { log(tr("Couldn't load calibration: {0}", errMsg(e)), "error"); }
}
export function deleteCalSlot(name: string) { try { localStorage.removeItem(CAL_PREFIX + name); } catch { /* ignore */ } }

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
    setCalibration(cal);
    set({ kit: cal.kit, enhancedResponse: cal.enhancedResponse });
    log(tr("Calibration loaded from {0}.", file.name));
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
