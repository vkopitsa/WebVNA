import { describe, expect, it } from "vitest";
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import type { ErrorTerms } from "./calibration";
import { applyCalibration } from "./calibration";
import { combineFlip, fakeFlip } from "./twoport";
import { cascade, flip, invert, renormalize2, s2t, t2s, type S2 } from "./s2";
import { seriesR, shuntC } from "./deembed";

const near = (a: Complex, b: Complex, tol = 1e-6) => expect(C.abs(C.sub(a, b))).toBeLessThan(tol);
const nearS2 = (a: S2, b: S2, tol = 1e-9) => a.forEach((v, k) => near(v, b[k], tol));

const N = 21, F0 = 100e6, F1 = 2e9;
const freqs = Array.from({ length: N }, (_, i) => F0 + ((F1 - F0) * i) / (N - 1));
// asymmetric, non-reciprocal-free DUT: series 20 Ω then shunt 3 pF
const dutAt = (f: number): S2 => cascade(seriesR(20, f), shuntC(3e-12, f));

const terms = (fs: number[]): ErrorTerms => {
  const g = (k: number): Complex[] => fs.map((_, i) => C.polar(k * (1 + 0.3 * Math.sin(i)), 0.4 * i + k));
  return { freqs: fs, e00: g(0.05), e11: g(0.1), T: g(0.9), iso: g(0.003), tr: g(0.8), e22: g(0.08), thruTrue: null };
};

/** Forward 12-term measurement model (source at VNA port 1, load match El). */
function measure(S: S2, i: number, t: ErrorTerms): { m11: Complex; m21: Complex } {
  const [s11, s12, s21, s22] = S;
  const ed = t.e00![i], es = t.e11![i], er = t.T![i], ex = t.iso![i], et = t.tr![i], el = t.e22![i];
  const dS = C.sub(C.mul(s11, s22), C.mul(s12, s21));
  const den = C.add(C.sub(C.sub([1, 0], C.mul(es, s11)), C.mul(el, s22)), C.mul(C.mul(es, el), dS));
  return {
    m11: C.add(ed, C.mul(er, C.div(C.sub(s11, C.mul(el, dS)), den))),
    m21: C.add(ex, C.mul(et, C.div(s21, den))),
  };
}

function synth(t: ErrorTerms, dut: (f: number) => S2) {
  const fwd: SweepPoint[] = [], rev: SweepPoint[] = [];
  t.freqs.forEach((f, i) => {
    const S = dut(f);
    const a = measure(S, i, t), b = measure(flip(S), i, t);
    fwd.push({ f, s11: a.m11, s21: a.m21 });
    rev.push({ f, s11: b.m11, s21: b.m21 });
  });
  return { fwd, rev };
}

describe("S2 / T-parameters", () => {
  it("S -> T -> S round trip", () => {
    const s: S2 = [[0.2, 0.1], [0.5, -0.3], [0.4, 0.2], [-0.1, 0.3]];
    nearS2(t2s(s2t(s)), s);
  });
  it("cascade with a thru is identity, invert undoes a network", () => {
    const s = dutAt(500e6);
    nearS2(cascade(s, [[0, 0], [1, 0], [1, 0], [0, 0]]), s);
    const id = cascade(invert(s), s);
    near(id[0], [0, 0]); near(id[2], [1, 0]); near(id[3], [0, 0]);
  });
  it("cascade of two series resistors is one series resistor", () => {
    nearS2(cascade(seriesR(10, 1e8), seriesR(15, 1e8)), seriesR(25, 1e8));
  });
  it("renormalize2: thru stays a thru, resistor matches new impedance", () => {
    nearS2(renormalize2([[0, 0], [1, 0], [1, 0], [0, 0]], 50, 75), [[0, 0], [1, 0], [1, 0], [0, 0]]);
    const r = renormalize2(seriesR(0, 1e8), 50, 75); // short between ports: still a thru
    near(r[2], [1, 0]);
  });
});

describe("combineFlip", () => {
  it("recovers all four S-parameters through a known error model", () => {
    const t = terms(freqs);
    const { fwd, rev } = synth(t, dutAt);
    const out = combineFlip(fwd, rev, t);
    out.forEach((p, i) => {
      const [s11, s12, s21, s22] = dutAt(freqs[i]);
      near(p.s11, s11); near(p.s12!, s12); near(p.s21, s21); near(p.s22!, s22);
    });
    // the DUT is genuinely asymmetric
    expect(C.abs(C.sub(out[5].s11, out[5].s22!))).toBeGreaterThan(0.05);
  });
  it("works with error terms on a different grid (linear interpolation)", () => {
    // terms linear in frequency are reproduced exactly by linear interpolation
    const lin = (a: Complex, b: Complex) => (f: number): Complex => C.lerp(a, b, (f - F0) / (F1 - F0));
    const coarse = [F0, F1];
    const mk = (a: Complex, b: Complex) => coarse.map((f) => lin(a, b)(f));
    const tc: ErrorTerms = { freqs: coarse, e00: mk([0.05, 0.01], [0.04, -0.02]), e11: mk([0.1, 0], [0.08, 0.03]), T: mk([0.9, 0.1], [0.7, -0.2]),
      iso: mk([0.003, 0], [0.002, 0.001]), tr: mk([0.8, 0], [0.6, 0.1]), e22: mk([0.07, 0], [0.05, 0.02]), thruTrue: null };
    const fine = { ...tc, freqs, e00: freqs.map(lin(tc.e00![0], tc.e00![1])), e11: freqs.map(lin(tc.e11![0], tc.e11![1])), T: freqs.map(lin(tc.T![0], tc.T![1])),
      iso: freqs.map(lin(tc.iso![0], tc.iso![1])), tr: freqs.map(lin(tc.tr![0], tc.tr![1])), e22: freqs.map(lin(tc.e22![0], tc.e22![1])) };
    const { fwd, rev } = synth(fine, dutAt);
    combineFlip(fwd, rev, tc).forEach((p, i) => { near(p.s11, dutAt(freqs[i])[0]); near(p.s22!, dutAt(freqs[i])[3]); near(p.s12!, dutAt(freqs[i])[1]); });
  });
  it("without e22 (no enhanced response) load match is 0", () => {
    const t = { ...terms(freqs), e22: null };
    const t0 = { ...t, e22: freqs.map(() => [0, 0] as Complex) };
    const { fwd, rev } = synth(t0, dutAt);
    combineFlip(fwd, rev, t).forEach((p, i) => { near(p.s21, dutAt(freqs[i])[2]); near(p.s12!, dutAt(freqs[i])[1]); });
  });
  it("null terms just assembles already-corrected data", () => {
    const fwd: SweepPoint[] = [{ f: 1e6, s11: [0.1, 0], s21: [0.5, 0.1] }];
    const rev: SweepPoint[] = [{ f: 1e6, s11: [0.2, 0.2], s21: [0.4, -0.1] }];
    const o = combineFlip(fwd, rev, null)[0];
    expect(o).toEqual({ f: 1e6, s11: [0.1, 0], s21: [0.5, 0.1], s12: [0.4, -0.1], s22: [0.2, 0.2] });
  });
  it("throws on mismatching grids", () => {
    const a: SweepPoint[] = [{ f: 1e6, s11: [0, 0], s21: [0, 0] }];
    expect(() => combineFlip(a, [], null)).toThrow();
    expect(() => combineFlip(a, [{ ...a[0], f: 1e6 + 10 }], null)).toThrow();
  });
});

describe("fakeFlip and applyCalibration passthrough", () => {
  it("fakeFlip mirrors s21 and s11", () => {
    const o = fakeFlip([{ f: 1, s11: [0.1, 0.2], s21: [0.3, 0.4] }])[0];
    expect(o.s12).toEqual([0.3, 0.4]); expect(o.s22).toEqual([0.1, 0.2]);
  });
  it("applyCalibration keeps s12/s22 untouched", () => {
    const t = terms([1e6]);
    const p: SweepPoint = { f: 1e6, s11: [0.2, 0.1], s21: [0.5, 0], s12: [0.7, 0.7], s22: [-0.3, 0.1] };
    const o = applyCalibration([p], t)[0];
    expect(o.s12).toEqual([0.7, 0.7]); expect(o.s22).toEqual([-0.3, 0.1]);
    expect(o.s11).not.toEqual(p.s11);
  });
});
