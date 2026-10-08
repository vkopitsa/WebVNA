// Fixture de-embedding / embedding ("fixture simulation"): remove or add 2-port networks (Touchstone files, lumped
// elements, transmission lines) at either port, then optionally renormalise to another port impedance.
import { C, ONE, ZERO, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { parseTouchstone } from "./touchstone";
import { IDENTITY_T, invM, mulT, renormalize1, renormalize2, s2t, t2s, type S2, type T2 } from "./s2";

export { cascade, flip, invert, renormalize1, renormalize2, s2t, t2s, THRU, type S2, type T2 } from "./s2";

const Z0 = 50;
const CLIGHT = 299792458;

// ---------- 2-port generators (reference impedance 50 Ω) ----------

/** Series impedance z between the two ports. */
export function seriesZ(z: Complex, z0 = Z0): S2 {
  const d = C.add(z, [2 * z0, 0]);
  return [C.div(z, d), C.div([2 * z0, 0], d), C.div([2 * z0, 0], d), C.div(z, d)];
}

/** Shunt admittance y (to ground) at the junction of the two ports. */
export function shuntY(y: Complex, z0 = Z0): S2 {
  const yn = C.scale(y, z0), d = C.add(yn, [2, 0]);
  return [C.neg(C.div(yn, d)), C.div([2, 0], d), C.div([2, 0], d), C.neg(C.div(yn, d))];
}

export type LumpedKind = "series" | "shunt";
export type LumpedElement = "R" | "L" | "C";

/** Impedance of a lumped R [Ω], L [H] or C [F] at f. */
export function elementZ(element: LumpedElement, value: number, f: number): Complex {
  const w = 2 * Math.PI * f;
  return element === "R" ? [value, 0] : element === "L" ? [0, w * value] : C.inv([0, w * value]);
}

export function lumped(kind: LumpedKind, element: LumpedElement, value: number, f: number): S2 {
  const z = elementZ(element, value, f);
  return kind === "series" ? seriesZ(z) : shuntY(C.inv(z));
}
export const seriesR = (r: number, f: number) => lumped("series", "R", r, f);
export const seriesL = (l: number, f: number) => lumped("series", "L", l, f);
export const seriesC = (c: number, f: number) => lumped("series", "C", c, f);
export const shuntR = (r: number, f: number) => lumped("shunt", "R", r, f);
export const shuntL = (l: number, f: number) => lumped("shunt", "L", l, f);
export const shuntC = (c: number, f: number) => lumped("shunt", "C", c, f);

/** Uniform transmission line; loss in dB/m at 1 GHz scaling with √f (skin effect). Reciprocal and symmetric. */
export function transmissionLine(z0line: number, lengthM: number, vf: number, lossDbPerM = 0, f: number, z0 = Z0): S2 {
  const alpha = (lossDbPerM * Math.sqrt(f / 1e9)) / (20 * Math.LOG10E);
  const beta = (2 * Math.PI * f) / (vf * CLIGHT);
  const e1 = C.scale(C.expj(-beta * lengthM), Math.exp(-alpha * lengthM)); // e^{−γl}
  const e2 = C.mul(e1, e1);
  const g = (z0line - z0) / (z0line + z0), g2 = g * g;
  const den = C.sub(ONE, C.scale(e2, g2));
  const s11 = C.div(C.scale(C.sub(ONE, e2), g), den);
  return [s11, C.div(C.scale(e1, 1 - g2), den), C.div(C.scale(e1, 1 - g2), den), s11];
}

// ---------- declarative fixture description (JSON-serialisable) ----------

export type FixtureOp = "deembed" | "embed";

export type FixtureStage =
  | { type: "file"; op: FixtureOp; name: string; points: { f: number; s: S2 }[] }
  | { type: "lumped"; op: FixtureOp; kind: LumpedKind; element: LumpedElement; value: number }
  | { type: "line"; op: FixtureOp; z0: number; lengthM: number; vf: number; lossDbPerM?: number };

/**
 * Stage lists run from the instrument towards the DUT and are applied in list order, each one to the current
 * outermost reference plane. Every stage network is oriented with its port 1 on the instrument side for port 1
 * and with its port 1 facing the DUT for port 2 (so port 2 of a stage is always the instrument side of port 2's fixture).
 * `z0`: renormalise the result to this real port impedance (50 or undefined = none).
 */
export interface FixtureSettings { enabled: boolean; port1: FixtureStage[]; port2: FixtureStage[]; z0?: number }

export const NO_FIXTURE: FixtureSettings = { enabled: false, port1: [], port2: [] };

function interpS2(pts: { f: number; s: S2 }[], f: number): S2 {
  const n = pts.length;
  if (f <= pts[0].f || n === 1) return pts[0].s;
  if (f >= pts[n - 1].f) return pts[n - 1].s;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].f <= f) lo = m; else hi = m; }
  const t = (f - pts[lo].f) / (pts[hi].f - pts[lo].f || 1);
  return pts[lo].s.map((v, k) => C.lerp(v, pts[hi].s[k], t)) as S2;
}

export function stageS(st: FixtureStage, f: number): S2 {
  if (st.type === "lumped") return lumped(st.kind, st.element, st.value, f);
  if (st.type === "line") return transmissionLine(st.z0, st.lengthM, st.vf, st.lossDbPerM ?? 0, f);
  if (!st.points.length) throw new Error(`Fixture file "${st.name}" has no data.`);
  return interpS2(st.points, f);
}

/** Build a fixture stage from a 2-port Touchstone file (S-parameters renormalised to 50 Ω). */
export function fixtureFromTouchstone(text: string, name: string, op: FixtureOp = "deembed"): FixtureStage {
  const t = parseTouchstone(text, name);
  if (t.ports !== 2) throw new Error("A fixture file must be a 2-port Touchstone file (.s2p).");
  return { type: "file", op, name, points: t.data.map((p) => ({ f: p.f, s: [p.s11, p.s12 ?? p.s21, p.s21, p.s22 ?? ZERO] as S2 })) };
}

/** Left (port 1) and right (port 2) T-multipliers such that T_result = L · T_measured · R. */
function multipliers(fx: FixtureSettings, f: number): { L: T2; R: T2; g: Complex } {
  let L = IDENTITY_T, R = IDENTITY_T, g: Complex = ONE; // g: product of stage S21s (inverted for de-embedding), both ports
  const gain = (s: S2, op: FixtureOp) => { g = C.mul(g, op === "embed" ? s[2] : C.inv(s[2])); };
  for (const st of fx.port1) { const s = stageS(st, f), t = s2t(s); L = mulT(st.op === "embed" ? t : invM(t), L); gain(s, st.op); }
  for (const st of fx.port2) { const s = stageS(st, f), t = s2t(s); R = mulT(R, st.op === "embed" ? t : invM(t)); gain(s, st.op); }
  return { L, R, g };
}

/**
 * Apply the fixture to a sweep.
 * - Full 2-port points (s12 and s22 present): exact T-matrix cascade T_res = L·T·R.
 * - Points with only S11/S21: S11 is corrected exactly as a one-port seen through the port-1 fixture
 *   (Γ_meas = e11 + e12e21·Γ/(1 − e22·Γ) inverted); S21 uses the APPROXIMATION S21_res = S21 · Π(stage S21)^±1
 *   (fixture reflections neglected; multiply for embed stages, divide for de-embed stages, both ports).
 * Finally everything present is renormalised to fx.z0 when it differs from 50 Ω. For S11/S21-only data S21 is
 * renormalised assuming a reciprocal DUT with S22 = 0.
 */
export function applyFixture(data: SweepPoint[], fx: FixtureSettings): SweepPoint[] {
  if (!fx.enabled) return data;
  const zn = fx.z0 && fx.z0 > 0 ? fx.z0 : Z0;
  return data.map((p) => {
    const { L, R, g } = multipliers(fx, p.f);
    let out: SweepPoint;
    if (p.s12 && p.s22) {
      const [s11, s12, s21, s22] = t2s(mulT(mulT(L, s2t([p.s11, p.s12, p.s21, p.s22])), R));
      out = { f: p.f, s11, s21, s12, s22 };
    } else {
      const E1 = t2s(invM(L));
      const d = C.sub(p.s11, E1[0]);
      const s11 = C.div(d, C.add(C.mul(E1[1], E1[2]), C.mul(E1[3], d)));
      const s21 = C.mul(p.s21, g);
      out = { f: p.f, s11, s21 };
    }
    if (zn === Z0) return out;
    if (out.s12 && out.s22) {
      const [s11, s12, s21, s22] = renormalize2([out.s11, out.s12, out.s21, out.s22], Z0, zn);
      return { f: p.f, s11, s21, s12, s22 };
    }
    return { f: p.f, s11: renormalize1(out.s11, Z0, zn), s21: renormalize2([out.s11, out.s21, out.s21, ZERO], Z0, zn)[2] };
  });
}
