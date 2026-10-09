// Full S-parameters from a one-path (S11/S21 only) instrument by measuring the DUT in both orientations
// (scikit-rf TwoPortOnePath / "flip the DUT").
import { C, ONE, ZERO } from "./complex";
import type { SweepPoint } from "./litevna";
import { interpTerms, type ErrorTerms } from "./calibration";

/** Symmetric reciprocal DUT: S12 = S21, S22 = S11. */
export const fakeFlip = (data: SweepPoint[]): SweepPoint[] => data.map((p) => ({ ...p, s12: p.s21, s22: p.s11 }));

/**
 * Combine RAW forward and reversed-DUT sweeps (same grid) into full S-parameters.
 * Reversed DUT means DUT port 2 sits on VNA port 1, so rev.s11 measures S22 and rev.s21 measures S12.
 * The reverse error terms are taken equal to the forward ones (switchless 3-receiver mirror: e33=e00, e11'=e11,
 * e23e32=e01e10, e10e32'=tr, load match e22 in both directions; e22 missing → 0) and the 12-term correction is applied:
 *   Nij = (m − directivity/isolation)/tracking,  D = (1+N11·Es)(1+N22·Es') − N21·N12·El·El'
 *   S11 = [N11(1+N22·Es') − El·N21·N12]/D   S21 = N21[1+N22(Es'−El)]/D
 *   S22 = [N22(1+N11·Es) − El'·N21·N12]/D   S12 = N12[1+N11(Es−El')]/D
 * With terms === null the sweeps are assumed already corrected and are simply assembled.
 */
export function combineFlip(fwd: SweepPoint[], rev: SweepPoint[], terms: ErrorTerms | null): SweepPoint[] {
  if (fwd.length !== rev.length) throw new Error("Forward and reversed sweeps have different lengths.");
  fwd.forEach((p, i) => { if (Math.abs(p.f - rev[i].f) > 1) throw new Error("Forward and reversed sweeps are on different frequency grids."); });
  if (!terms) return fwd.map((p, i) => ({ f: p.f, s11: p.s11, s21: p.s21, s12: rev[i].s21, s22: rev[i].s11 }));
  const same = terms.freqs.length === fwd.length && fwd.every((p, i) => Math.abs(p.f - terms.freqs[i]) < 1);
  const t = same ? terms : interpTerms(terms, fwd.map((p) => p.f));
  return fwd.map((p, i) => {
    const r = rev[i];
    const ed = t.e00?.[i] ?? ZERO, es = t.e11?.[i] ?? ZERO, er = t.T?.[i] ?? ONE;
    const ex = t.iso?.[i] ?? ZERO, et = t.tr?.[i] ?? ONE, el = t.e22?.[i] ?? ZERO;
    const N11 = C.div(C.sub(p.s11, ed), er), N22 = C.div(C.sub(r.s11, ed), er);
    const N21 = C.div(C.sub(p.s21, ex), et), N12 = C.div(C.sub(r.s21, ex), et);
    const x = C.mul(C.mul(N21, N12), C.mul(el, el)); // N21·N12·El·El'
    const d = C.sub(C.mul(C.add(ONE, C.mul(N11, es)), C.add(ONE, C.mul(N22, es))), x);
    const n21n12 = C.mul(N21, N12);
    const s11 = C.div(C.sub(C.mul(N11, C.add(ONE, C.mul(N22, es))), C.mul(el, n21n12)), d);
    const s22 = C.div(C.sub(C.mul(N22, C.add(ONE, C.mul(N11, es))), C.mul(el, n21n12)), d);
    const s21 = C.div(C.mul(N21, C.add(ONE, C.mul(N22, C.sub(es, el)))), d);
    const s12 = C.div(C.mul(N12, C.add(ONE, C.mul(N11, C.sub(es, el)))), d);
    return { f: p.f, s11, s21, s12, s22 };
  });
}

