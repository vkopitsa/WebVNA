// 2×2 complex S-parameter matrices: S↔T conversion, cascade, inversion, port flip, reference-impedance renormalisation.
import { C, ONE, ZERO, type Complex } from "./complex";

/** [s11, s12, s21, s22] */
export type S2 = [Complex, Complex, Complex, Complex];

/**
 * T-parameters (transfer-scattering), convention [b1; a1] = T·[a2; b2]:
 *   T11 = −det(S)/S21, T12 = S11/S21, T21 = −S22/S21, T22 = 1/S21 (stored [T11, T12, T21, T22]).
 * Cascading networks (port 2 of A to port 1 of B) is the plain matrix product T_A·T_B.
 */
export type T2 = [Complex, Complex, Complex, Complex];

export const IDENTITY_T: T2 = [ONE, ZERO, ZERO, ONE];

export function s2t(s: S2): T2 {
  const [s11, s12, s21, s22] = s;
  const det = C.sub(C.mul(s11, s22), C.mul(s12, s21));
  return [C.neg(C.div(det, s21)), C.div(s11, s21), C.neg(C.div(s22, s21)), C.inv(s21)];
}

export function t2s(t: T2): S2 {
  const [t11, t12, t21, t22] = t;
  const det = C.sub(C.mul(t11, t22), C.mul(t12, t21));
  return [C.div(t12, t22), C.div(det, t22), C.inv(t22), C.neg(C.div(t21, t22))];
}

export const mulT = (a: T2, b: T2): T2 => [
  C.add(C.mul(a[0], b[0]), C.mul(a[1], b[2])), C.add(C.mul(a[0], b[1]), C.mul(a[1], b[3])),
  C.add(C.mul(a[2], b[0]), C.mul(a[3], b[2])), C.add(C.mul(a[2], b[1]), C.mul(a[3], b[3])),
];

/** Inverse of any 2×2 complex matrix (same layout as S2/T2). */
export function invM(m: T2): T2 {
  const det = C.sub(C.mul(m[0], m[3]), C.mul(m[1], m[2]));
  return [C.div(m[3], det), C.neg(C.div(m[1], det)), C.neg(C.div(m[2], det)), C.div(m[0], det)];
}

/** Cascade two 2-ports: port 2 of `a` connected to port 1 of `b`. */
export const cascade = (a: S2, b: S2): S2 => t2s(mulT(s2t(a), s2t(b)));

/** Inverse network: cascade(invert(a), a) is a perfect thru. */
export const invert = (a: S2): S2 => t2s(invM(s2t(a)));

/** Swap the ports of a network. */
export const flip = (s: S2): S2 => [s[3], s[2], s[1], s[0]];

/** Perfect thru. */
export const THRU: S2 = [ZERO, ONE, ONE, ZERO];

/** Renormalise S from real port impedance z0old to z0new (both ports): S' = (S − ρI)(I − ρS)⁻¹, ρ = (zn − zo)/(zn + zo). Works for thrus. */
export function renormalize2(s: S2, z0old: number, z0new: number): S2 {
  if (z0old === z0new) return s;
  const r = (z0new - z0old) / (z0new + z0old);
  const a: T2 = [C.sub(s[0], [r, 0]), s[1], s[2], C.sub(s[3], [r, 0])];
  const b: T2 = [C.sub(ONE, C.scale(s[0], r)), C.scale(s[1], -r), C.scale(s[2], -r), C.sub(ONE, C.scale(s[3], r))];
  return mulT(a, invM(b));
}

/** One-port renormalisation (reflection coefficient). */
export function renormalize1(g: Complex, z0old: number, z0new: number): Complex {
  if (z0old === z0new) return g;
  const r = (z0new - z0old) / (z0new + z0old);
  return C.div(C.sub(g, [r, 0]), C.sub(ONE, C.scale(g, r)));
}
