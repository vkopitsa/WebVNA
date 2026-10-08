// Simulator: speaks the same byte protocol as a LiteVNA (hw rev 2, fw 2.2), with checksums, vbat and screenshots.
import { C, type Complex } from "./complex";
import { DATA_MODE, OP, REG, fifoChecksum } from "./protocol";
import { LinkBase } from "./links";
import { cascade, seriesR, shuntC } from "./deembed";

export type Dut = "antenna" | "open" | "short" | "load" | "thru" | "isolation" | "filter" | "crystal" | "cable" | "rlc" | "pad";
export const DUTS: Dut[] = ["antenna", "filter", "crystal", "cable", "rlc", "pad", "open", "short", "load", "thru", "isolation"];

const Z0 = 50;
const gammaOf = (z: Complex): Complex => C.div(C.sub(z, [Z0, 0]), C.add(z, [Z0, 0]));

/** Asymmetric reciprocal 2-port ("pad"): series 20 Ω followed by a 3 pF shunt (port 1 on the series side). [S11, S12, S21, S22]. */
const padS = (f: number) => cascade(seriesR(20, f), shuntC(3e-12, f));

/** True S11/S21 of the simulated device under test. */
export function dutS(dut: Dut, f: number): { s11: Complex; s21: Complex } {
  const w = 2 * Math.PI * f;
  switch (dut) {
    case "open": return { s11: [1, 0], s21: [0, 0] };
    case "short": return { s11: [-1, 0], s21: [0, 0] };
    case "load": case "isolation": return { s11: [0, 0], s21: [0, 0] };
    case "thru": return { s11: [0, 0], s21: [1, 0] };
    case "filter": {
      // 3rd-order-ish bandpass, 145 MHz centre, ~12 MHz bandwidth, 1.5 dB loss.
      const f0 = 145e6, bw = 12e6, x = (f / f0 - f0 / f) * (f0 / bw);
      const h = C.div([0.84, 0], [1 - 2 * x * x, 2 * x - x * x * x]);
      const s11 = C.sqrt(C.sub([1, 0], C.mul(h, h)));
      return { s11: C.scale(s11, 0.97), s21: C.mul(h, C.expj(-w * 6e-9)) };
    }
    case "crystal": {
      // Series crystal in a 50 Ω through fixture: Rm 20 Ω, Lm 10 mH, fs ≈ 10 MHz, Cp 4 pF.
      const Rm = 20, Lm = 0.01, Cm = 1 / (Math.pow(2 * Math.PI * 10e6, 2) * Lm), Cp = 4e-12;
      const zm: Complex = [Rm, w * Lm - 1 / (w * Cm)];
      const zp: Complex = [0, -1 / (w * Cp)];
      const z = C.div(C.mul(zm, zp), C.add(zm, zp));
      const s21 = C.div([2 * Z0, 0], C.add(z, [2 * Z0, 0]));
      return { s11: C.div(z, C.add(z, [2 * Z0, 0])), s21 };
    }
    case "cable": {
      // 3 m of RG-58 (VF 0.66), open at the far end, ~0.1 dB/m/√(100 MHz).
      const len = 3, vf = 0.66, loss = 0.0115 * Math.sqrt(f / 100e6) * len;
      const t = (2 * w * len) / (3e8 * vf);
      return { s11: C.polar(Math.pow(10, (-2 * loss) / 20), -t), s21: C.polar(Math.pow(10, -loss / 20), -t / 2) };
    }
    case "pad": { const [s11, , s21] = padS(f); return { s11, s21 }; }
    case "rlc": {
      // 33 Ω + 120 nH + 47 pF series to ground.
      const z: Complex = [33, w * 120e-9 - 1 / (w * 47e-12)];
      return { s11: gammaOf(z), s21: [0, 0] };
    }
    default: {
      const f0 = 435e6, R = 38, Q = 14, x = R * Q * (f / f0 - f0 / f);
      return { s11: gammaOf([R, x]), s21: [0, 0] };
    }
  }
}

/** All four true S-parameters; DUTs without a 2-port model are treated as symmetric (S12 = S21, S22 = S11). */
export function dutS4(dut: Dut, f: number): { s11: Complex; s21: Complex; s12: Complex; s22: Complex } {
  if (dut === "pad") { const [s11, s12, s21, s22] = padS(f); return { s11, s21, s12, s22 }; }
  const { s11, s21 } = dutS(dut, f);
  return { s11, s21, s12: s21, s22: s11 };
}

export class MockLink extends LinkBase {
  kind = "Simulator";
  reg = new Uint8Array(256);
  dut: Dut = "antenna";
  /** DUT physically flipped: port 1 sees DUT port 2 (S22 / S12), as after turning the DUT around. */
  reversed = false;
  noise = 30;
  private inbox: number[] = [];
  private idx = 0;

  constructor() {
    super();
    const init: Record<number, number> = { 0xf0: 2, 0xf1: 1, 0xf2: 2, 0xf3: 2, 0xf4: 2, 0x40: 1, 0x41: 1, 0x42: 3 };
    for (const [k, v] of Object.entries(init)) this.reg[+k] = v;
    this.reg[REG.VBAT_MV] = 4012 & 0xff;
    this.reg[REG.VBAT_MV + 1] = 4012 >> 8;
    for (let i = 0; i < 12; i++) this.reg[0xd0 + i] = (i * 37 + 11) & 0xff;
  }

  private u(addr: number, n: number): number {
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.reg[addr + i]);
    return Number(v);
  }

  private sample(i: number): Uint8Array {
    const f = this.u(REG.SWEEP_START, 8) + i * this.u(REG.SWEEP_STEP, 8);
    const ph = -2 * Math.PI * f * 1.2e-9;
    const t4 = dutS4(this.dut, f);
    const G = this.reversed ? t4.s22 : t4.s11, S = this.reversed ? t4.s12 : t4.s21;
    const deviceCal = this.reg[REG.DATA_MODE] === DATA_MODE.DEVICE_CAL;
    let m: Complex, s21: Complex;
    if (deviceCal) { m = G; s21 = S; }
    else {
      const e00 = C.polar(0.06, ph * 0.3 + 1), e11 = C.polar(0.08, ph * 0.5), T = C.polar(0.85, ph);
      m = C.add(e00, C.div(C.mul(T, G), C.sub([1, 0], C.mul(e11, G))));
      const thru = C.polar(0.7, ph * 1.4), leak = C.polar(0.001, ph);
      // the pad is a physical 2-port: the source-match error re-reflects off its input (S21/(1 − e11·S11)); other DUTs keep the simple model
      const Sx = this.dut === "pad" ? C.div(S, C.sub([1, 0], C.mul(e11, G))) : S;
      s21 = C.add(C.mul(thru, Sx), leak);
    }
    const pw = [0.5, 0.7, 0.85, 1][Math.min(3, this.reg[REG.POWER_HF])];
    const fwd = C.polar(2e5 * pw, ph * 2 + 0.4);
    const nz = this.noise / Math.sqrt(Math.max(1, this.reg[REG.AVERAGE]));
    const n = () => (Math.random() - 0.5) * nz;
    const rev0 = C.mul(fwd, m), rev1 = C.mul(fwd, s21);
    const ch = this.reg[REG.CHANNELS];
    const rec = new Uint8Array(32), dv = new DataView(rec.buffer);
    const vals = [fwd[0], fwd[1], ch === 2 ? 0 : rev0[0], ch === 2 ? 0 : rev0[1], ch === 1 ? 0 : rev1[0], ch === 1 ? 0 : rev1[1]];
    vals.forEach((v, k) => dv.setInt32(k * 4, Math.round(v + n()), true));
    dv.setUint16(24, i, true);
    rec[31] = fifoChecksum(rec);
    return rec;
  }

  protected async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Simulator closed.");
    this.inbox.push(...bytes);
    const out: number[] = [];
    const need: Record<number, number> = {
      [OP.NOP]: 1, [OP.INDICATE]: 1, [OP.READ]: 2, [OP.READ2]: 2, [OP.READ4]: 2, [OP.READ8]: 2,
      [OP.READFIFO]: 3, [OP.WRITE]: 3, [OP.WRITE2]: 4, [OP.WRITE4]: 6, [OP.WRITE8]: 10,
    };
    while (this.inbox.length) {
      const op = this.inbox[0], len = need[op];
      if (!len) { if (this.inbox.length < 3) break; this.inbox.splice(0, 3); continue; } // unknown op eats 2 more bytes
      if (this.inbox.length < len) break;
      const c = this.inbox.splice(0, len), a = c[1];
      if (op === OP.INDICATE) out.push(0x32);
      else if (op >= OP.READ && op <= OP.READ8) out.push(...this.reg.slice(a, a + [1, 2, 4, 8][op - OP.READ]));
      else if (op >= OP.WRITE && op <= OP.WRITE8) {
        c.slice(2).forEach((v, k) => { this.reg[a + k] = v; });
        if (a === REG.VALUES_FIFO) this.idx = 0;
        if (a === REG.CAPTURE) {
          const w = 96, h = 64;
          out.push(w & 255, w >> 8, h & 255, h >> 8, 16);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const v = (((x * 31) / w) << 11) | (((y * 63) / h) << 5) | 8;
              out.push(v >> 8, v & 255);
            }
        }
      } else if (op === OP.READFIFO) {
        const pts = Math.max(1, this.u(REG.SWEEP_POINTS, 2)), n = c[2] || pts;
        for (let k = 0; k < n; k++) { out.push(...this.sample(this.idx)); this.idx = (this.idx + 1) % pts; }
      }
    }
    if (out.length) setTimeout(() => this.push(Uint8Array.from(out)), 2);
  }

  async close(): Promise<void> { this.closed = true; }
}
