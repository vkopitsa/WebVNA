// Complex numbers as [re, im] tuples (same convention as src/core.js).
export type Complex = [number, number];

export const C = {
  add: (a: Complex, b: Complex): Complex => [a[0] + b[0], a[1] + b[1]],
  sub: (a: Complex, b: Complex): Complex => [a[0] - b[0], a[1] - b[1]],
  mul: (a: Complex, b: Complex): Complex => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
  div: (a: Complex, b: Complex): Complex => {
    const d = b[0] * b[0] + b[1] * b[1] || 1e-30;
    return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
  },
  scale: (a: Complex, k: number): Complex => [a[0] * k, a[1] * k],
  abs: (a: Complex): number => Math.hypot(a[0], a[1]),
  abs2: (a: Complex): number => a[0] * a[0] + a[1] * a[1],
  arg: (a: Complex): number => Math.atan2(a[1], a[0]),
  polar: (r: number, t: number): Complex => [r * Math.cos(t), r * Math.sin(t)],
  conj: (a: Complex): Complex => [a[0], -a[1]],
  neg: (a: Complex): Complex => [-a[0], -a[1]],
  /** 1/a; an infinite a (e.g. Z of an exact open) gives 0. */
  inv: (a: Complex): Complex => (a[0] === Infinity || a[0] === -Infinity || a[1] === Infinity || a[1] === -Infinity ? [0, 0] : C.div([1, 0], a)),
  /** e^{jθ} */
  expj: (t: number): Complex => [Math.cos(t), Math.sin(t)],
  lerp: (a: Complex, b: Complex, t: number): Complex => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
  sqrt: (a: Complex): Complex => {
    const r = Math.sqrt(C.abs(a)), t = C.arg(a) / 2;
    return [r * Math.cos(t), r * Math.sin(t)];
  },
};

export const ONE: Complex = [1, 0];
export const ZERO: Complex = [0, 0];
