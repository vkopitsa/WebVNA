import { describe, expect, it } from "vitest";
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { writeTouchstone } from "./touchstone";
import {
  applyFixture, cascade, fixtureFromTouchstone, flip, lumped, renormalize2, s2t, seriesR, shuntC, t2s, transmissionLine,
  type FixtureSettings, type FixtureStage,
} from "./deembed";

const near = (a: Complex, b: Complex, tol = 1e-9) => expect(C.abs(C.sub(a, b))).toBeLessThan(tol);
const freqs = Array.from({ length: 11 }, (_, i) => 100e6 + i * 190e6);
const gammaOf = (z: Complex): Complex => C.div(C.sub(z, [50, 0]), C.add(z, [50, 0]));

const lumpedStage = (op: "embed" | "deembed"): FixtureStage => ({ type: "lumped", op, kind: "shunt", element: "C", value: 2e-12 });
const lineStage = (op: "embed" | "deembed"): FixtureStage => ({ type: "line", op, z0: 62, lengthM: 0.07, vf: 0.66, lossDbPerM: 3 });
const fileStage = (op: "embed" | "deembed"): FixtureStage => ({
  type: "file", op, name: "fx.s2p",
  points: [100e6, 1e9, 2e9].map((f) => ({ f, s: cascade(lumped("series", "L", 3e-9, f), lumped("shunt", "C", 1e-12, f)) })),
});

const full = (f: number): SweepPoint => {
  const [s11, s12, s21, s22] = cascade(seriesR(30, f), shuntC(2e-12, f));
  return { f, s11, s21, s12, s22 };
};
const oneport = (f: number): SweepPoint => ({ f, s11: C.polar(0.5, f / 3e8), s21: C.polar(0.3, -f / 5e8) });

describe("lumped / line generators", () => {
  it("series 100 ohm: S11 = 100/200, S21 = 100/200 ... checks", () => {
    const s = lumped("series", "R", 100, 1e8);
    near(s[0], [0.5, 0]); near(s[2], [0.5, 0]);
  });
  it("shunt 50 ohm: S11 = -1/3, S21 = 2/3", () => {
    const s = lumped("shunt", "R", 50, 1e8);
    near(s[0], [-1 / 3, 0]); near(s[2], [2 / 3, 0]);
  });
  it("matched line shifts phase by 2*beta*L on S11 and beta*L on S21", () => {
    const f = 1e9, len = 0.1, vf = 0.7, beta = (2 * Math.PI * f) / (vf * 299792458);
    const line = transmissionLine(50, len, vf, 0, f);
    near(line[0], [0, 0]);
    near(line[2], C.polar(1, -beta * len));
    // short at the end of the line: Gamma = -1 * e^{-2j beta L}
    const g = C.mul(line[2], C.mul(line[1], [-1, 0]));
    near(g, C.polar(-1, -2 * beta * len));
    // via the fixture: embedding the line rotates a one-port by 2 beta L
    const fx: FixtureSettings = { enabled: true, port1: [{ type: "line", op: "embed", z0: 50, lengthM: len, vf }], port2: [] };
    const o = applyFixture([{ f, s11: [-1, 0], s21: [0, 0] }], fx)[0];
    near(o.s11, C.polar(-1, -2 * beta * len));
  });
  it("lossy line attenuates with sqrt(f)", () => {
    const a = C.abs(transmissionLine(50, 1, 0.7, 2, 1e9)[2]);
    const b = C.abs(transmissionLine(50, 1, 0.7, 2, 4e9)[2]);
    expect(20 * Math.log10(a)).toBeCloseTo(-2, 6);
    expect(20 * Math.log10(b)).toBeCloseTo(-4, 6);
  });
});

describe("T <-> S", () => {
  it("round trips and cascade equals T product", () => {
    const a = cascade(seriesR(10, 1e9), shuntC(1e-12, 1e9));
    t2s(s2t(a)).forEach((v, k) => near(v, a[k]));
    const f = flip(a);
    near(f[0], a[3]); near(f[3], a[0]);
  });
});

describe("applyFixture", () => {
  const stages = { lumped: lumpedStage, line: lineStage, file: fileStage };
  for (const kind of ["lumped", "line", "file"] as const) {
    it(`embed then de-embed is identity (${kind}, full 2-port)`, () => {
      const mk = (op: "embed" | "deembed") => ({ enabled: true, port1: [stages[kind](op)], port2: [stages[kind](op)] }) as FixtureSettings;
      const data = freqs.map(full);
      const emb = applyFixture(data, mk("embed"));
      expect(C.abs(C.sub(emb[3].s21, data[3].s21))).toBeGreaterThan(1e-3);
      const back = applyFixture(emb, mk("deembed"));
      back.forEach((p, i) => { near(p.s11, data[i].s11); near(p.s21, data[i].s21); near(p.s12!, data[i].s12!); near(p.s22!, data[i].s22!); });
    });
    it(`embed then de-embed is identity (${kind}, S11/S21 only)`, () => {
      const mk = (op: "embed" | "deembed") => ({ enabled: true, port1: [stages[kind](op)], port2: [stages[kind](op)] }) as FixtureSettings;
      const data = freqs.map(oneport);
      // one-port reflection round trip is exact
      const back = applyFixture(applyFixture(data, mk("embed")), mk("deembed"));
      back.forEach((p, i) => { near(p.s11, data[i].s11); near(p.s21, data[i].s21); });
    });
  }
  it("de-embedding a line from a line-terminated load gives the load", () => {
    const load = C.div(C.sub([20, 30], [50, 0]), C.add([20, 30], [50, 0]));
    const fx: FixtureSettings = { enabled: true, port1: [lineStage("deembed")], port2: [] };
    const pts = freqs.map((f) => {
      const l = transmissionLine(62, 0.07, 0.66, 3, f);
      return { f, s11: C.add(l[0], C.div(C.mul(C.mul(l[1], l[2]), load), C.sub([1, 0], C.mul(l[3], load)))), s21: [0, 0] as Complex };
    });
    applyFixture(pts, fx).forEach((p) => near(p.s11, load));
  });
  it("full 2-port de-embedding of both ports recovers the DUT (port 2 oriented facing the DUT)", () => {
    const dutAt = (f: number) => full(f);
    const a = (f: number) => transmissionLine(60, 0.03, 0.7, 0, f), b = (f: number) => lumped("shunt", "C", 1.5e-12, f);
    const meas: SweepPoint[] = freqs.map((f) => {
      const [s11, s12, s21, s22] = cascade(cascade(a(f), [dutAt(f).s11, dutAt(f).s12!, dutAt(f).s21, dutAt(f).s22!]), b(f));
      return { f, s11, s21, s12, s22 };
    });
    const fx: FixtureSettings = {
      enabled: true,
      port1: [{ type: "line", op: "deembed", z0: 60, lengthM: 0.03, vf: 0.7 }],
      port2: [{ type: "lumped", op: "deembed", kind: "shunt", element: "C", value: 1.5e-12 }],
    };
    applyFixture(meas, fx).forEach((p, i) => { const d = dutAt(freqs[i]); near(p.s11, d.s11); near(p.s21, d.s21); near(p.s12!, d.s12!); near(p.s22!, d.s22!); });
  });
  it("S21 approximation divides by both fixture S21 and multiplies when embedding", () => {
    const f = 1e9;
    const fx = (op: "embed" | "deembed"): FixtureSettings => ({ enabled: true, port1: [{ type: "line", op, z0: 50, lengthM: 0.1, vf: 0.7 }], port2: [{ type: "line", op, z0: 50, lengthM: 0.05, vf: 0.7 }] });
    const l1 = transmissionLine(50, 0.1, 0.7, 0, f)[2], l2 = transmissionLine(50, 0.05, 0.7, 0, f)[2];
    const p: SweepPoint = { f, s11: [0, 0], s21: [0.5, 0] };
    near(applyFixture([p], fx("embed"))[0].s21, C.mul(C.mul(l1, l2), [0.5, 0]));
    near(applyFixture([p], fx("deembed"))[0].s21, C.div([0.5, 0], C.mul(l1, l2)));
  });
  it("disabled returns data unchanged; no stages is identity", () => {
    const d = freqs.map(full);
    expect(applyFixture(d, { enabled: false, port1: [lineStage("deembed")], port2: [] })).toBe(d);
    applyFixture(d, { enabled: true, port1: [], port2: [] }).forEach((p, i) => { near(p.s11, d[i].s11); near(p.s21, d[i].s21); });
  });
  it("renormalising to 75 ohm turns a 75 ohm resistor into Gamma = 0", () => {
    const g = gammaOf([75, 0]);
    const o = applyFixture([{ f: 1e8, s11: g, s21: [0, 0] }], { enabled: true, port1: [], port2: [], z0: 75 })[0];
    near(o.s11, [0, 0]);
    // full 2-port: 75 ohm series resistor-less thru stays a thru, 75 ohm line is matched
    const l = transmissionLine(75, 0.1, 0.7, 0, 1e9);
    const p: SweepPoint = { f: 1e9, s11: l[0], s21: l[2], s12: l[1], s22: l[3] };
    const q = applyFixture([p], { enabled: true, port1: [], port2: [], z0: 75 })[0];
    near(q.s11, [0, 0], 1e-9); near(q.s22!, [0, 0], 1e-9);
    near(q.s21, renormalize2(l, 50, 75)[2]);
  });
});

describe("fixtureFromTouchstone", () => {
  it("builds a file stage from .s2p text and rejects .s1p", () => {
    const data = freqs.map(full);
    const stage = fixtureFromTouchstone(writeTouchstone(data, 2), "fx.s2p");
    expect(stage.type).toBe("file");
    const back = applyFixture(applyFixture(data, { enabled: true, port1: [{ ...stage, op: "embed" } as FixtureStage], port2: [] }), { enabled: true, port1: [stage], port2: [] });
    back.forEach((p, i) => { near(p.s11, data[i].s11, 1e-6); near(p.s21, data[i].s21, 1e-6); });
    expect(() => fixtureFromTouchstone(writeTouchstone(data, 1), "x.s1p")).toThrow();
  });
  it("is JSON-serialisable", () => {
    const fx: FixtureSettings = { enabled: true, port1: [fileStage("deembed"), lineStage("embed")], port2: [lumpedStage("deembed")], z0: 75 };
    expect(JSON.parse(JSON.stringify(fx))).toEqual(fx);
  });
});
