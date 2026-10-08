// Calibration (docs/04-CALIBRATION.md): one-port SOL with cal-kit models, response/isolation/thru for S21,
// enhanced response, interpolation onto any sweep, electrical delay, JSON save/load.
import { C, ONE, ZERO, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";

export const Z0 = 50;

export type Standard = "open" | "short" | "load" | "thru" | "isolation";
export const STANDARDS: Standard[] = ["open", "short", "load", "isolation", "thru"];

export interface CalKit {
  name: string;
  /** Open: C0 [fF], C1 [1e-27 F/Hz], C2 [1e-36 F/Hz²], C3 [1e-45 F/Hz³], offset delay [ps] */
  open: { c0: number; c1: number; c2: number; c3: number; delayPs: number };
  /** Short: L0 [pH], L1 [1e-24 H/Hz], L2 [1e-33 H/Hz²], L3 [1e-42 H/Hz³], offset delay [ps] */
  short: { l0: number; l1: number; l2: number; l3: number; delayPs: number };
  /** Load: resistance [Ω], series inductance [pH], offset delay [ps] */
  load: { r: number; lPh: number; delayPs: number };
  /** Thru: offset delay [ps] */
  thru: { delayPs: number };
}

export const IDEAL_KIT: CalKit = {
  name: "Ideal",
  open: { c0: 0, c1: 0, c2: 0, c3: 0, delayPs: 0 },
  short: { l0: 0, l1: 0, l2: 0, l3: 0, delayPs: 0 },
  load: { r: 50, lPh: 0, delayPs: 0 },
  thru: { delayPs: 0 },
};

/** Typical SMA kit shipped with LiteVNA / NanoVNA V2 (values from NanoVNA-Saver defaults). */
export const SMA_KIT: CalKit = {
  name: "Generic SMA",
  open: { c0: 50, c1: 0, c2: 0, c3: 0, delayPs: 0 },
  short: { l0: 0, l1: 0, l2: 0, l3: 0, delayPs: 0 },
  load: { r: 50, lPh: 0, delayPs: 0 },
  thru: { delayPs: 0 },
};

const withDelay = (g: Complex, f: number, delayPs: number): Complex =>
  delayPs ? C.mul(g, C.expj(-2 * 2 * Math.PI * f * delayPs * 1e-12)) : g;
const gammaZ = (z: Complex): Complex => C.div(C.sub(z, [Z0, 0]), C.add(z, [Z0, 0]));

export function kitGamma(kit: CalKit, std: "open" | "short" | "load", f: number): Complex {
  const w = 2 * Math.PI * f;
  if (std === "open") {
    const o = kit.open;
    const c = (o.c0 * 1e-15) + (o.c1 * 1e-27) * f + (o.c2 * 1e-36) * f * f + (o.c3 * 1e-45) * f * f * f;
    const g: Complex = c > 0 ? gammaZ([0, -1 / (w * c)]) : [1, 0];
    return withDelay(g, f, o.delayPs);
  }
  if (std === "short") {
    const s = kit.short;
    const l = (s.l0 * 1e-12) + (s.l1 * 1e-24) * f + (s.l2 * 1e-33) * f * f + (s.l3 * 1e-42) * f * f * f;
    return withDelay(gammaZ([0, w * l]), f, s.delayPs);
  }
  const l = kit.load;
  return withDelay(gammaZ([l.r, w * l.lPh * 1e-12]), f, l.delayPs);
}

export interface CalData {
  name: string;
  created: string;
  freqs: number[];
  kit: CalKit;
  enhancedResponse: boolean;
  /** Raw measurements per standard. For thru, s11 during the thru is kept for enhanced response. */
  open?: Complex[];
  short?: Complex[];
  load?: Complex[];
  isolation?: Complex[];
  thru?: Complex[];
  thru11?: Complex[];
}

export interface ErrorTerms {
  freqs: number[];
  e00: Complex[] | null; // directivity
  e11: Complex[] | null; // source match
  T: Complex[] | null;   // reflection tracking (e01e10)
  iso: Complex[] | null; // isolation (e30)
  tr: Complex[] | null;  // transmission tracking (e10e32)
  e22: Complex[] | null; // port-2 load match (enhanced response)
  thruTrue: Complex[] | null;
}

/** Solve 3×3 complex linear system A·x = b by Gaussian elimination with partial pivoting. */
function solve3(A: Complex[][], b: Complex[]): Complex[] {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (C.abs(M[r][c]) > C.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = C.div(M[r][c], M[c][c]);
      for (let j = c; j < 4; j++) M[r][j] = C.sub(M[r][j], C.mul(k, M[c][j]));
    }
  }
  return [0, 1, 2].map((i) => C.div(M[i][3], M[i][i]));
}

/** General SOL: M = e00 + T·Γ/(1 − e11·Γ)  ⇔  e00 + (Γ·M)·e11 − Γ·Δe = M, with Δe = e00·e11 − T. */
export function solveSOLGeneral(meas: [Complex, Complex, Complex], gam: [Complex, Complex, Complex]) {
  const A = meas.map((m, i) => [ONE, C.mul(gam[i], m), C.neg(gam[i])]);
  const [e00, e11, de] = solve3(A, meas);
  return { e00, e11, T: C.sub(C.mul(e00, e11), de) };
}

/** Ideal-standard SOL (closed form, same as src/core.js). */
export function solveSOL(open: Complex[], short: Complex[], load: Complex[]) {
  return open.map((_, i) => {
    const a = C.sub(open[i], load[i]), b = C.sub(short[i], load[i]), amb = C.sub(a, b);
    return { e00: load[i], e11: C.div(C.add(a, b), amb), T: C.div(C.scale(C.mul(a, b), -2), amb) };
  });
}

const isIdeal = (k: CalKit) =>
  !k.open.c0 && !k.open.c1 && !k.open.c2 && !k.open.c3 && !k.open.delayPs &&
  !k.short.l0 && !k.short.l1 && !k.short.l2 && !k.short.l3 && !k.short.delayPs &&
  k.load.r === 50 && !k.load.lPh && !k.load.delayPs;

export function correctS11(m: Complex, e00: Complex, e11: Complex, T: Complex): Complex {
  const d = C.sub(m, e00);
  return C.div(d, C.add(T, C.mul(e11, d)));
}

export function computeErrorTerms(cal: CalData): ErrorTerms {
  const n = cal.freqs.length;
  const t: ErrorTerms = { freqs: cal.freqs, e00: null, e11: null, T: null, iso: null, tr: null, e22: null, thruTrue: null };
  const { open, short, load, kit } = cal;
  if (open && short && load) {
    t.e00 = []; t.e11 = []; t.T = [];
    if (isIdeal(kit)) {
      for (const e of solveSOL(open, short, load)) { t.e00.push(e.e00); t.e11.push(e.e11); t.T.push(e.T); }
    } else {
      for (let i = 0; i < n; i++) {
        const f = cal.freqs[i];
        const e = solveSOLGeneral([open[i], short[i], load[i]], [kitGamma(kit, "open", f), kitGamma(kit, "short", f), kitGamma(kit, "load", f)]);
        t.e00.push(e.e00); t.e11.push(e.e11); t.T.push(e.T);
      }
    }
  } else if (open || short) {
    // Response-only reflection calibration (with directivity if a load was measured).
    t.e00 = load ? load.slice() : Array.from({ length: n }, () => ZERO);
    t.e11 = Array.from({ length: n }, () => ZERO);
    t.T = Array.from({ length: n }, (_, i) => {
      const f = cal.freqs[i];
      return open ? C.div(C.sub(open[i], t.e00![i]), kitGamma(kit, "open", f)) : C.div(C.sub(short![i], t.e00![i]), kitGamma(kit, "short", f));
    });
  }
  if (cal.isolation) t.iso = cal.isolation.slice();
  if (cal.thru) {
    t.thruTrue = cal.freqs.map((f) => (kit.thru.delayPs ? C.expj(-2 * Math.PI * f * kit.thru.delayPs * 1e-12) : ONE));
    t.tr = []; t.e22 = [];
    for (let i = 0; i < n; i++) {
      const x = t.iso ? C.sub(cal.thru[i], t.iso[i]) : cal.thru[i];
      const s21t = t.thruTrue[i];
      if (cal.enhancedResponse && t.e00 && t.e11 && t.T && cal.thru11) {
        const e22 = correctS11(cal.thru11[i], t.e00[i], t.e11[i], t.T[i]);
        t.e22.push(e22);
        // M21 − e30 = e10e32·S21/(1 − e11·e22·S21²) for a matched thru
        t.tr.push(C.div(C.mul(x, C.sub(ONE, C.mul(C.mul(t.e11[i], e22), C.mul(s21t, s21t)))), s21t));
      } else {
        t.e22.push(ZERO);
        t.tr.push(C.div(x, s21t));
      }
    }
    if (!cal.enhancedResponse) t.e22 = null;
  }
  return t;
}

/** Linear interpolation of a complex array defined at sorted freqs. */
function interp(freqs: number[], arr: Complex[], f: number, hint: { i: number }): Complex {
  const n = freqs.length;
  if (n === 1 || f <= freqs[0]) return arr[0];
  if (f >= freqs[n - 1]) return arr[n - 1];
  let i = Math.min(Math.max(hint.i, 0), n - 2);
  while (i > 0 && freqs[i] > f) i--;
  while (i < n - 2 && freqs[i + 1] < f) i++;
  hint.i = i;
  const t = (f - freqs[i]) / (freqs[i + 1] - freqs[i] || 1);
  return C.lerp(arr[i], arr[i + 1], t);
}

export interface Correction {
  s11Delay: number; // seconds (electrical delay / port extension, applied as e^{+jωτ})
  s21Delay: number;
  s21OffsetDb: number;
}

export const NO_CORRECTION: Correction = { s11Delay: 0, s21Delay: 0, s21OffsetDb: 0 };

/** Apply error terms (interpolated when the sweep differs from the cal grid) and electrical delay. */
export function applyCalibration(raw: SweepPoint[], terms: ErrorTerms | null, corr: Correction = NO_CORRECTION): SweepPoint[] {
  const same = terms && terms.freqs.length === raw.length && raw.every((p, i) => Math.abs(p.f - terms.freqs[i]) < 1);
  const h = { i: 0 };
  const off = Math.pow(10, corr.s21OffsetDb / 20);
  return raw.map((p, i) => {
    let s11 = p.s11, s21 = p.s21;
    if (terms) {
      const g = (a: Complex[] | null) => (a ? (same ? a[i] : interp(terms.freqs, a, p.f, h)) : null);
      const e00 = g(terms.e00), e11 = g(terms.e11), T = g(terms.T), iso = g(terms.iso), tr = g(terms.tr), e22 = g(terms.e22);
      if (e00 && e11 && T) s11 = correctS11(p.s11, e00, e11, T);
      let x = iso ? C.sub(p.s21, iso) : p.s21;
      if (tr) {
        x = C.div(x, tr);
        if (e22 && e11) x = C.mul(x, C.sub(ONE, C.mul(e11, s11)));
      }
      s21 = x;
    }
    const w = 2 * Math.PI * p.f;
    if (corr.s11Delay) s11 = C.mul(s11, C.expj(w * corr.s11Delay));
    if (corr.s21Delay) s21 = C.mul(s21, C.expj(w * corr.s21Delay));
    if (off !== 1) s21 = C.scale(s21, off);
    return { f: p.f, s11, s21 };
  });
}

export function calSummary(cal: CalData | null): string {
  if (!cal) return "none";
  const have = STANDARDS.filter((s) => cal[s]);
  const f0 = cal.freqs[0], f1 = cal.freqs[cal.freqs.length - 1];
  return `${have.map((s) => s.toUpperCase()).join(" ")} · ${(f0 / 1e6).toFixed(3)}–${(f1 / 1e6).toFixed(3)} MHz · ${cal.freqs.length} pts`;
}

export function calCovers(cal: CalData, start: number, stop: number): boolean {
  return start >= cal.freqs[0] - 1 && stop <= cal.freqs[cal.freqs.length - 1] + 1;
}

export function serializeCal(cal: CalData): string { return JSON.stringify({ format: "webvna-cal", version: 1, ...cal }); }

const isPair = (c: unknown) => Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);
/** Numeric fields of a cal-kit section from a file, defaults for anything missing or non-numeric. */
const kitSection = <T extends object>(d: T, v: unknown): T =>
  Object.fromEntries(Object.entries(d).map(([k, dv]) => { const x = (v as Record<string, unknown> | null)?.[k]; return [k, typeof x === "number" && Number.isFinite(x) ? x : dv]; })) as T;

export function parseCal(text: string): CalData {
  const o = JSON.parse(text);
  const bad = () => new Error("Not a WebVNA calibration file.");
  if (o?.format !== "webvna-cal" || !Array.isArray(o.freqs) || !o.freqs.length || !o.freqs.every((f: unknown) => Number.isFinite(f))) throw bad();
  for (const k of ["open", "short", "load", "isolation", "thru", "thru11"])
    if (o[k] != null && (!Array.isArray(o[k]) || o[k].length !== o.freqs.length || !o[k].every(isPair))) throw bad();
  if (!o.freqs.every((f: number, i: number) => i === 0 || f > o.freqs[i - 1])) throw bad(); // interpolation and calCovers need ascending freqs
  for (const k of ["name", "created"]) if (o[k] != null && typeof o[k] !== "string") throw bad();
  if (o.enhancedResponse != null && typeof o.enhancedResponse !== "boolean") throw bad();
  if (o.kit != null && (typeof o.kit !== "object" || Array.isArray(o.kit))) throw bad();
  const k = o.kit ?? {};
  const kit: CalKit = { name: typeof k.name === "string" ? k.name : IDEAL_KIT.name, open: kitSection(IDEAL_KIT.open, k.open), short: kitSection(IDEAL_KIT.short, k.short), load: kitSection(IDEAL_KIT.load, k.load), thru: kitSection(IDEAL_KIT.thru, k.thru) };
  delete o.format; delete o.version;
  return { name: "", created: "", enhancedResponse: false, ...o, kit } as CalData;
}
