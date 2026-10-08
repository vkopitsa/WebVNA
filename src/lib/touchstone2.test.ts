import { describe, expect, it } from "vitest";
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { parseTouchstone, writeTouchstone } from "./touchstone";
import { renormalize2, type S2 } from "./s2";

const near = (a: Complex, b: Complex, tol = 1e-8) => expect(C.abs(C.sub(a, b))).toBeLessThan(tol);
const pts: SweepPoint[] = [1e8, 5e8, 9e8].map((f, i) => ({
  f, s11: [0.1 * (i + 1), -0.2], s21: [0.5, 0.1 * i], s12: [0.45, -0.05 * i], s22: [-0.3, 0.1 * (i + 1)],
}));

describe("2-port Touchstone", () => {
  for (const fmt of ["RI", "MA", "DB"] as const) {
    it(`round-trips all four S-parameters (${fmt})`, () => {
      const t = parseTouchstone(writeTouchstone(pts, 2, "t", fmt), "a.s2p");
      expect(t.ports).toBe(2);
      t.data.forEach((p, i) => { near(p.s11, pts[i].s11); near(p.s21, pts[i].s21); near(p.s12!, pts[i].s12!); near(p.s22!, pts[i].s22!); });
      expect(Math.round(t.data[1].f)).toBe(5e8);
    });
  }
  it("without s12/s22 keeps the old convention S12 = S21, S22 = 0", () => {
    const t = parseTouchstone(writeTouchstone([{ f: 1e8, s11: [0.1, 0], s21: [0.5, 0.2] }], 2), "a.s2p");
    near(t.data[0].s12!, [0.5, 0.2]); near(t.data[0].s22!, [0, 0]);
  });
  it("1-port files have no s12/s22", () => {
    const t = parseTouchstone(writeTouchstone(pts, 1), "a.s1p");
    expect(t.data[0].s12).toBeUndefined();
  });
  it("order is S11 S21 S12 S22 on disk", () => {
    const txt = "# Hz S RI R 50\n100 0.1 0 0.2 0 0.3 0 0.4 0\n";
    const d = parseTouchstone(txt, "x.s2p").data[0];
    near(d.s11, [0.1, 0]); near(d.s21, [0.2, 0]); near(d.s12!, [0.3, 0]); near(d.s22!, [0.4, 0]);
  });
  it("renormalises a 75 ohm file to 50 ohm (all four parameters)", () => {
    // 75 ohm matched through-line referenced to 75 ohm: S11 = S22 = 0, S21 = S12 = e^{-j theta}
    const txt = "# MHz S RI R 75\n100 0 0 0.6 0.8 0.6 0.8 0 0\n";
    const d = parseTouchstone(txt, "x.s2p").data[0];
    const exp = renormalize2([[0, 0], [0.6, 0.8], [0.6, 0.8], [0, 0]], 75, 50);
    near(d.s11, exp[0]); near(d.s12!, exp[1]); near(d.s21, exp[2]); near(d.s22!, exp[3]);
    // 75 -> 50: reflection of a matched 75 ohm line seen at 50 ohm is (75-50)/(75+50) = 0.2 at the ends
    expect(C.abs(d.s11)).toBeGreaterThan(0.01);
    // and back again recovers the original
    const back = renormalize2([d.s11, d.s12!, d.s21, d.s22!] as S2, 50, 75);
    near(back[0], [0, 0]); near(back[2], [0.6, 0.8]);
  });
  it("renormalises a 75 ohm round trip through write/parse", () => {
    const body = writeTouchstone(pts, 2).replace("R 50", "R 75");
    const d = parseTouchstone(body, "x.s2p").data;
    d.forEach((p, i) => {
      const e = renormalize2([pts[i].s11, pts[i].s12!, pts[i].s21, pts[i].s22!], 75, 50);
      near(p.s11, e[0]); near(p.s12!, e[1]); near(p.s21, e[2]); near(p.s22!, e[3]);
    });
  });
  it("renormalises a 75 ohm one-port: a 75 ohm resistor reads Gamma = 0.2 at 50 ohm", () => {
    const d = parseTouchstone("# Hz S RI R 75\n1000 0 0\n", "x.s1p").data[0];
    near(d.s11, [0.2, 0]);
  });
});
