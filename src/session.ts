// Session/project files (full state as JSON) and compact shareable links (#s=<deflate+base64url>).
import type { SweepPoint } from "./lib/litevna";
import { parseCal, serializeCal, type CalData } from "./lib/calibration";
import type { Complex } from "./lib/complex";
import { get, log, mergePersisted, persistedSettings, set, type MemorySlot, type RefFile, MEMORY_SLOTS } from "./store";
import { download, recompute, setCalibration, stop } from "./controller";
import { tr } from "./i18n";

const SESSION_FORMAT = "webvna-session";
const SHARE_FORMAT = "webvna-share";
const VERSION = 1;
/** URLs longer than this are unreliable in chat apps and some servers. */
export const SHARE_WARN_LENGTH = 30000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ------------------------------------------------------------------ validation */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isComplex = (v: unknown): v is Complex => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

/** Strictly validate a sweep; returns a clean copy. Frequencies must increase. */
export function checkSweep(v: unknown, what: string): SweepPoint[] {
  if (!Array.isArray(v)) throw new Error(tr("Session: {0} must be a list of points.", what));
  let last = -Infinity;
  return v.map((p, i) => {
    if (!isObj(p) || !isNum(p.f) || !isComplex(p.s11) || !isComplex(p.s21) || (p.s12 !== undefined && !isComplex(p.s12)) || (p.s22 !== undefined && !isComplex(p.s22)))
      throw new Error(tr("Session: {0} has a malformed point #{1}.", what, i + 1));
    if (p.f <= last) throw new Error(tr("Session: {0} frequencies must increase (point #{1}).", what, i + 1));
    last = p.f;
    const out: SweepPoint = { f: p.f, s11: p.s11, s21: p.s21 };
    if (p.s12) out.s12 = p.s12 as Complex;
    if (p.s22) out.s22 = p.s22 as Complex;
    return out;
  });
}

function checkCal(v: unknown): CalData {
  if (!isObj(v) || !Array.isArray(v.freqs) || !v.freqs.length || !v.freqs.every(isNum)) throw new Error(tr("Session: the calibration is malformed."));
  const n = v.freqs.length;
  for (const k of ["open", "short", "load", "isolation", "thru", "thru11"]) {
    const a = v[k];
    if (a !== undefined && (!Array.isArray(a) || a.length !== n || !a.every(isComplex))) throw new Error(tr("Session: the calibration is malformed."));
  }
  return parseCal(JSON.stringify({ format: "webvna-cal", version: 1, ...v }));
}

/* ------------------------------------------------------------------ session files */

export interface SessionFile {
  format: typeof SESSION_FORMAT;
  version: number;
  created: string;
  settings: Record<string, unknown>;
  cal: unknown;
  data?: { raw: SweepPoint[]; data: SweepPoint[] };
  memories: Partial<Record<MemorySlot, SweepPoint[]>>;
  refs: RefFile[];
  twoPort?: { result: SweepPoint[] };
}

export function exportSession(includeData = true): SessionFile {
  const s = get();
  const out: SessionFile = {
    format: SESSION_FORMAT, version: VERSION, created: new Date().toISOString(),
    settings: persistedSettings(s),
    cal: s.cal ? JSON.parse(serializeCal(s.cal)) : null,
    memories: s.memories,
    refs: s.refs,
  };
  if (includeData && s.raw.length) out.data = { raw: s.raw, data: s.data };
  if (s.twoPort.result) out.twoPort = { result: s.twoPort.result };
  return out;
}

export const serializeSession = (includeData = true) => JSON.stringify(exportSession(includeData));

/** Validate a session object or JSON text and apply it. Throws a descriptive Error for malformed input. */
export function importSession(input: unknown): void {
  let o = input;
  if (typeof input === "string") {
    try { o = JSON.parse(input); } catch { throw new Error(tr("Session: not valid JSON.")); }
  }
  if (!isObj(o) || o.format !== SESSION_FORMAT) throw new Error(tr("Not a WebVNA session file."));
  if (!isNum(o.version) || o.version > VERSION) throw new Error(tr("Session: unsupported version {0}.", String(o.version)));
  if (!isObj(o.settings)) throw new Error(tr("Session: settings are missing."));

  // validate everything before touching the store
  const cal = o.cal == null ? null : checkCal(o.cal);
  let raw: SweepPoint[] | null = null, data: SweepPoint[] | null = null;
  if (o.data !== undefined) {
    if (!isObj(o.data)) throw new Error(tr("Session: the measurement data is malformed."));
    raw = checkSweep(o.data.raw, "raw data");
    data = o.data.data === undefined ? null : checkSweep(o.data.data, "data");
  }
  const memories: Partial<Record<MemorySlot, SweepPoint[]>> = {};
  if (o.memories !== undefined) {
    if (!isObj(o.memories)) throw new Error(tr("Session: memories are malformed."));
    for (const k of MEMORY_SLOTS) if (o.memories[k] !== undefined) memories[k] = checkSweep(o.memories[k], `memory ${k}`);
  }
  const refs: RefFile[] = [];
  if (o.refs !== undefined) {
    if (!Array.isArray(o.refs)) throw new Error(tr("Session: references are malformed."));
    for (const r of o.refs) {
      if (!isObj(r) || typeof r.name !== "string") throw new Error(tr("Session: references are malformed."));
      refs.push({ name: r.name, data: checkSweep(r.data, `reference "${r.name}"`), ports: r.ports === 1 ? 1 : 2, visible: r.visible !== false, color: typeof r.color === "string" ? r.color : "#3fb7e8" });
    }
  }
  const twoPort = isObj(o.twoPort) && o.twoPort.result ? checkSweep(o.twoPort.result, "2-port result") : null;

  // structural checks on the raw settings (clear errors); mergePersisted then drops/repairs any individual invalid value
  const rawSettings = o.settings;
  const bad = (k: string, ok: (v: number) => boolean) => k in rawSettings && !(isNum(rawSettings[k]) && ok(rawSettings[k] as number));
  if (bad("start", (v) => v > 0) || bad("stop", (v) => v > 0) || bad("cwFreq", (v) => v > 0) || bad("points", (v) => Number.isInteger(v) && v >= 1))
    throw new Error(tr("Session: the sweep settings are invalid."));
  if (rawSettings.traces !== undefined && (!Array.isArray(rawSettings.traces) || !rawSettings.traces.every((t) => isObj(t))))
    throw new Error(tr("Session: the trace settings are invalid."));
  const settings = mergePersisted(rawSettings);
  delete settings.lang; // the interface language is a personal choice
  stop();
  setCalibration(cal); // first: it forces calEnabled, which the settings then override
  if (cal) set({ kit: cal.kit, enhancedResponse: cal.enhancedResponse });
  set({ ...settings, memories, refs, twoPort: { fwd: null, rev: null, result: twoPort }, raw: raw ?? [], data: raw ? (data ?? []) : [] });
  recompute();
  log(tr("Session loaded: {0} points.", raw?.length ?? 0));
}

export function saveSessionFile() {
  const name = `${get().autoSaveName || "webvna"}-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.webvna.json`;
  download(name, serializeSession(), "application/json");
  log(tr("Saved {0}", name));
}

export async function openSessionFile(file: File) {
  try { importSession(await file.text()); log(tr("Opened session {0}.", file.name)); }
  catch (e) { log(tr("Import {0}: {1}", file.name, errMsg(e)), "error"); }
}

/* ------------------------------------------------------------------ shareable links */

export const canShare = () => typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

const SHARE_SETTINGS = ["start", "stop", "points", "sweepMode", "cwFreq", "traces", "markers", "smithAdmittance", "smithReadout", "showSmith", "showRect", "tdr"];

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
const toUrl = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrl = (t: string) => unb64(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (t.length % 4)) % 4));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Compact payload: settings subset + corrected S11/S21 as float32 (little endian). No calibration. */
export function sharePayload(): Record<string, unknown> {
  const s = get();
  if (!s.data.length) throw new Error(tr("Nothing to share yet: sweep first."));
  const d = s.data, n = d.length;
  const f32 = new Float32Array(n * 4);
  d.forEach((p, i) => { f32.set([p.s11[0], p.s11[1], p.s21[0], p.s21[1]], i * 4); });
  const df = n > 1 ? (d[n - 1].f - d[0].f) / (n - 1) : 0;
  const linear = d.every((p, i) => Math.abs(p.f - (d[0].f + i * df)) <= Math.max(1, Math.abs(df) * 1e-6));
  const settings: Record<string, unknown> = {};
  for (const k of SHARE_SETTINGS) settings[k] = (s as unknown as Record<string, unknown>)[k];
  return {
    format: SHARE_FORMAT, version: VERSION, settings, n,
    ...(linear ? { f0: d[0].f, df } : { f: b64(new Uint8Array(Float64Array.from(d, (p) => p.f).buffer)) }),
    s: b64(new Uint8Array(f32.buffer)),
  };
}

export async function encodeShare(payload: Record<string, unknown> = sharePayload()): Promise<string> {
  if (!canShare()) throw new Error(tr("This browser can't compress links; save a session file instead."));
  return toUrl(await pipe(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream("deflate-raw")));
}

export interface SharedView { settings: Record<string, unknown>; data: SweepPoint[] }

export async function decodeShare(token: string): Promise<SharedView> {
  if (!canShare()) throw new Error(tr("This browser can't decompress links."));
  let o: unknown;
  try { o = JSON.parse(new TextDecoder().decode(await pipe(fromUrl(token), new DecompressionStream("deflate-raw")))); }
  catch { throw new Error(tr("The shared link is damaged.")); }
  if (!isObj(o) || o.format !== SHARE_FORMAT || o.version !== VERSION || !isObj(o.settings) || !Number.isInteger(o.n) || (o.n as number) < 1 || typeof o.s !== "string")
    throw new Error(tr("The shared link is damaged."));
  const n = o.n as number;
  const bytes = unb64(o.s);
  if (bytes.length !== n * 16) throw new Error(tr("The shared link is damaged."));
  const v = new Float32Array(bytes.buffer, bytes.byteOffset, n * 4);
  let freqs: ArrayLike<number>;
  if (typeof o.f === "string") {
    const fb = unb64(o.f);
    if (fb.length !== n * 8) throw new Error(tr("The shared link is damaged."));
    freqs = new Float64Array(fb.buffer, fb.byteOffset, n);
  } else if (isNum(o.f0) && isNum(o.df)) { const f0 = o.f0, df = o.df; freqs = Array.from({ length: n }, (_, i) => f0 + i * df); }
  else throw new Error(tr("The shared link is damaged."));
  const data: SweepPoint[] = Array.from({ length: n }, (_, i) => ({ f: freqs[i], s11: [v[i * 4], v[i * 4 + 1]], s21: [v[i * 4 + 2], v[i * 4 + 3]] }));
  return { settings: o.settings, data: checkSweep(data, "shared data") };
}

/** Only the display subset a link may carry: never device settings, calibration, kit or simulator choices. */
export function sharedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SHARE_SETTINGS) if (k in settings) out[k] = settings[k];
  return out;
}

/** Show a shared measurement without connecting: it is already corrected, so calibration, fixture and gate are switched off. */
export function applySharedView(v: SharedView) {
  stop();
  const s = get();
  set({
    ...mergePersisted(sharedSettings(v.settings)), calEnabled: false, fixture: { ...s.fixture, enabled: false }, gate: { ...s.gate, enabled: false },
    raw: v.data, frozen: false, twoPort: { fwd: null, rev: null, result: null },
  });
  recompute();
}

export async function shareLink(): Promise<string> {
  const token = await encodeShare();
  const url = `${location.origin}${location.pathname}#s=${token}`;
  return url;
}

/** Copy a shareable link to the clipboard (warns if it is long). */
export async function copyShareLink() {
  try {
    const url = await shareLink();
    await navigator.clipboard.writeText(url);
    if (url.length > SHARE_WARN_LENGTH) log(tr("Link copied, but it is {0} characters long and may not work everywhere. Save a session file instead for large sweeps.", url.length), "error");
    else log(tr("Link copied to the clipboard ({0} characters).", url.length));
  } catch (e) { log(tr("Share: {0}", errMsg(e)), "error"); }
}

/** App boot: load a measurement from `#s=…` in the URL. Returns true when the hash held a shared link. */
export async function loadSharedFromHash(): Promise<boolean> {
  if (typeof location === "undefined" || !location.hash.startsWith("#s=")) return false;
  const token = location.hash.slice(3);
  history.replaceState(null, "", location.pathname + location.search);
  try { applySharedView(await decodeShare(token)); log(tr("Loaded shared measurement")); }
  catch (e) { log(errMsg(e), "error"); }
  return true;
}
