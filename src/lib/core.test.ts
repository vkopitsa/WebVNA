import { describe, expect, it } from "vitest";
import { C, type Complex } from "./complex";
import { LiteVNA, planSegments, type SweepPoint } from "./litevna";
import { MockLink, dutS } from "./mock";
import { fifoChecksum, isForbiddenWrite, OP, REG, DATA_MODE } from "./protocol";
import { applyCalibration, computeErrorTerms, IDEAL_KIT, kitGamma, parseCal, serializeCal, solveSOLGeneral, type CalData, type CalKit } from "./calibration";
import { formatValue, groupDelay, impedance, swr, traceValues } from "./formats";
import { parseTouchstone, writeCsv, writeTouchstone } from "./touchstone";
import { cableAnalysis, crystalAnalysis, filterAnalysis, lcMatch, resonances, search, swrBandwidth } from "./analysis";
import { DEFAULT_TDR, fft, timeDomain } from "./tdr";
import { parseHz, parseSI, si } from "./units";
import { stepScale } from "../components/ScaleTools";

const S = 300e6, E = 600e6, N = 301;

async function setup() {
  const link = new MockLink(), vna = new LiteVNA(link);
  await vna.init();
  return { link, vna };
}

async function calibrate(link: MockLink, vna: LiteVNA, start = S, stop = E, n = N, kit: CalKit = IDEAL_KIT, enhanced = false): Promise<CalData> {
  const meas = async (d: Parameters<typeof dutS>[0]) => { link.dut = d; return vna.sweep(start, stop, n); };
  const o = await meas("open"), s = await meas("short"), l = await meas("load"), iso = await meas("isolation"), t = await meas("thru");
  return {
    name: "t", created: "", freqs: o.map((p) => p.f), kit, enhancedResponse: enhanced,
    open: o.map((p) => p.s11), short: s.map((p) => p.s11), load: l.map((p) => p.s11),
    isolation: iso.map((p) => p.s21), thru: t.map((p) => p.s21), thru11: t.map((p) => p.s11),
  };
}

const maxErr = (data: SweepPoint[], ch: "s11" | "s21", dut: Parameters<typeof dutS>[0]) =>
  Math.max(...data.map((p) => C.abs(C.sub(p[ch], dutS(dut, p.f)[ch]))));

describe("device driver (simulator)", () => {
  it("identifies the LiteVNA", async () => {
    const { vna } = await setup();
    expect(vna.info?.model).toBe("LiteVNA");
    expect(vna.info?.maxPoints).toBe(65535);
  });
  it("reads vbat, serial and screenshot", async () => {
    const { vna } = await setup();
    expect(await vna.readVbat()).toBe(4.012);
    expect(await vna.readSerial()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/);
    const shot = await vna.screenshot();
    expect(shot.rgba.length).toBe(shot.width * shot.height * 4);
  });
  it("orders points by freqIndex", async () => {
    const { vna } = await setup();
    const d = await vna.sweep(S, E, N);
    expect(d.every((p, i) => Math.abs(p.f - (S + i * 1e6)) < 1)).toBe(true);
  });
  it("does segmented sweeps", async () => {
    const { vna } = await setup();
    const big = await vna.sweep(1e6, 6e9, 3001);
    expect(big.length).toBe(3001);
  });
  it("does approximated log sweeps", async () => {
    const segs = planSegments(1e6, 1e9, 201, "log");
    expect(segs.reduce((a, s) => a + s.points, 0)).toBe(201);
    const { vna } = await setup();
    const d = await vna.sweepSegments(segs);
    expect(d.length).toBe(201);
    expect(d[0].f).toBeCloseTo(1e6, -1);
    expect(d[200].f).toBeCloseTo(1e9, -3);
  });
  it("validates the checksum", () => {
    const rec = new Uint8Array(32);
    rec[3] = 7;
    rec[31] = fifoChecksum(rec);
    expect(fifoChecksum(rec)).toBe(rec[31]);
    rec[3] ^= 1;
    expect(fifoChecksum(rec)).not.toBe(rec[31]);
  });
  it("refuses to write protected registers", async () => {
    const { vna } = await setup();
    expect(() => vna.write1(0xe0, 1)).toThrow();
    expect(() => vna.write1(REG.DATA_MODE, DATA_MODE.RAW)).toThrow();
  });
  it("checks every byte of a multi-byte write", async () => {
    const { vna } = await setup();
    expect(() => vna.write8(0xdc, 0)).toThrow(); // bytes land on 0xE0..0xE3
    expect(() => vna.write2(0xed, 0)).toThrow();
    expect(isForbiddenWrite(REG.CAPTURE, OP.WRITE)).toBe(false);
    expect(isForbiddenWrite(0x1f, OP.WRITE8, [0, 0, 0, 0, 0, 0, 0, DATA_MODE.RAW])).toBe(true); // 8th byte hits DATA_MODE
    expect(isForbiddenWrite(0x1f, OP.WRITE8, [0, 0, 0, 0, 0, 0, 0, 0])).toBe(false);
    expect(isForbiddenWrite(0x25, OP.WRITE2, 0x0100)).toBe(true); // packed number: high byte lands on DATA_MODE
    expect(isForbiddenWrite(0x25, OP.WRITE2, 0x0001)).toBe(false);
  });
  it("log plan is strictly increasing and stays within the span", () => {
    const expand = (segs: ReturnType<typeof planSegments>) =>
      segs.flatMap((s) => { const st = s.points > 1 ? Math.round((s.stop - s.start) / (s.points - 1)) : 0; return Array.from({ length: s.points }, (_, i) => s.start + i * st); });
    const f = expand(planSegments(10e3, 100e3, 65535, "log"));
    expect(f.length).toBe(65535);
    expect(f.every((x, i) => i === 0 || x > f[i - 1])).toBe(true);
    expect(f[0]).toBe(10e3);
    expect(f[f.length - 1]).toBeLessThanOrEqual(100e3);
    expect(planSegments(10e3, 10.001e3, 65535, "log")).toEqual([{ start: 10e3, stop: 10.001e3, points: 65535 }]); // too narrow: linear
  });
  it("aborts a sweep", async () => {
    const { vna } = await setup();
    const ac = new AbortController();
    ac.abort();
    await expect(vna.sweep(S, E, 2000, { signal: ac.signal })).rejects.toThrow(/stopped/);
  });
  it("supports device-calibrated data mode", async () => {
    const { link, vna } = await setup();
    await vna.setDataMode(DATA_MODE.DEVICE_CAL);
    link.dut = "antenna";
    const d = await vna.sweep(S, E, 101);
    expect(maxErr(d, "s11", "antenna")).toBeLessThan(0.005);
  });
});

describe("calibration", () => {
  it("SOL corrects S11 and thru normalises S21", async () => {
    const { link, vna } = await setup();
    const cal = await calibrate(link, vna);
    const terms = computeErrorTerms(cal);
    link.dut = "antenna";
    const corr = applyCalibration(await vna.sweep(S, E, N), terms);
    expect(maxErr(corr, "s11", "antenna")).toBeLessThan(0.005);
    const best = corr.reduce((a, p) => (swr(p.s11) < swr(a.s11) ? p : a));
    expect(best.f).toBe(435e6);
    expect(impedance(best.s11, "s11")[0]).toBeCloseTo(38, 0);
    link.dut = "thru";
    const t = applyCalibration(await vna.sweep(S, E, N), terms).map((p) => C.abs(p.s21));
    expect(Math.min(...t)).toBeGreaterThan(0.999);
    expect(Math.max(...t)).toBeLessThan(1.001);
  });
  it("interpolates onto a different sweep", async () => {
    const { link, vna } = await setup();
    const terms = computeErrorTerms(await calibrate(link, vna, 100e6, 1000e6, 901));
    link.dut = "antenna";
    const corr = applyCalibration(await vna.sweep(400e6, 470e6, 57), terms);
    expect(maxErr(corr, "s11", "antenna")).toBeLessThan(0.01);
  });
  it("general solver matches the ideal solver", () => {
    const g: [Complex, Complex, Complex] = [[1, 0], [-1, 0], [0, 0]];
    const e00: Complex = [0.05, 0.02], e11: Complex = [0.1, -0.05], T: Complex = [0.8, 0.3];
    const meas = g.map((G) => C.add(e00, C.div(C.mul(T, G), C.sub([1, 0], C.mul(e11, G))))) as [Complex, Complex, Complex];
    const e = solveSOLGeneral(meas, g);
    expect(C.abs(C.sub(e.e00, e00))).toBeLessThan(1e-9);
    expect(C.abs(C.sub(e.e11, e11))).toBeLessThan(1e-9);
    expect(C.abs(C.sub(e.T, T))).toBeLessThan(1e-9);
  });
  it("cal-kit model changes the open standard", () => {
    const kit: CalKit = { ...IDEAL_KIT, open: { ...IDEAL_KIT.open, c0: 50 } };
    const g = kitGamma(kit, "open", 1e9);
    expect(C.abs(g)).toBeCloseTo(1, 6);
    expect(C.arg(g)).toBeLessThan(-0.01);
  });
  it("enhanced response corrects S21 of a mismatched DUT", async () => {
    const { link, vna } = await setup();
    const terms = computeErrorTerms(await calibrate(link, vna, S, E, N, IDEAL_KIT, true));
    link.dut = "thru";
    const t = applyCalibration(await vna.sweep(S, E, N), terms);
    expect(maxErr(t, "s21", "thru")).toBeLessThan(0.01);
  });
  it("serialises and parses", async () => {
    const { link, vna } = await setup();
    const cal = await calibrate(link, vna, S, E, 11);
    const back = parseCal(serializeCal(cal));
    expect(back.freqs).toEqual(cal.freqs);
    expect(back.open).toEqual(cal.open);
  });
});

describe("formats and analysis", () => {
  const ant = Array.from({ length: 301 }, (_, i) => { const f = S + i * 1e6; return { f, ...dutS("antenna", f) }; });
  it("computes impedance and SWR", () => {
    const p = ant[135];
    expect(p.f).toBe(435e6);
    expect(formatValue("r", p.s11, p.f, "s11")).toBeCloseTo(38, 6);
    expect(formatValue("x", p.s11, p.f, "s11")).toBeCloseTo(0, 6);
    expect(formatValue("swr", p.s11, p.f, "s11")).toBeCloseTo(50 / 38, 6);
  });
  it("an exact open is Z = ∞, Y = 0", () => {
    expect(impedance([1, 0], "s11")).toEqual([Infinity, 0]);
    expect(impedance([0, 0], "s21")).toEqual([Infinity, 0]);
    expect(formatValue("r", [1, 0], 1e9, "s11")).toBe(Infinity);
    expect(formatValue("g", [1, 0], 1e9, "s11")).toBe(0);
    expect(formatValue("absy", [1, 0], 1e9, "s11")).toBe(0);
  });
  it("finds the VSWR bandwidth and resonance", () => {
    const b = swrBandwidth(ant)!;
    expect(ant[b.best].f).toBe(435e6);
    expect(b.low! < 435e6 && b.high! > 435e6).toBe(true);
    const r = resonances(ant);
    expect(r[0].f).toBeCloseTo(435e6, -4);
  });
  it("searches peaks", () => {
    const v = [0, 1, 0, 3, 0, 2, 0];
    expect(search(v, "max")).toBe(3);
    expect(search(v, "peak_right", 3)).toBe(5);
    expect(search(v, "peak_left", 3)).toBe(1);
  });
  it("computes group delay", () => {
    const d = Array.from({ length: 101 }, (_, i) => { const f = 1e8 + i * 1e6; return { f, s11: [0, 0] as Complex, s21: C.expj(-2 * Math.PI * f * 5e-9) }; });
    expect(groupDelay(d)[50]).toBeCloseTo(5e-9, 12);
    expect(traceValues(d, "s21", "delay")[50]).toBeCloseTo(5e-9, 12);
  });
  it("L/C match transforms the load to 50 Ω", () => {
    const sols = lcMatch([20, 30], 100e6);
    expect(sols.length).toBeGreaterThan(0);
  });
  it("an exact open has Y = 0 and no L/C match", () => {
    const z = impedance([1, 0], "s11");
    expect(z[0]).toBe(Infinity);
    expect(C.inv(z)).toEqual([0, 0]);
    expect(formatValue("g", [1, 0], 1e8, "s11")).toBe(0);
    expect(lcMatch(z, 100e6)).toEqual([]);
    expect(lcMatch([NaN, NaN], 100e6)).toEqual([]);
  });
  it("analyses a band-pass filter", () => {
    const d = Array.from({ length: 801 }, (_, i) => { const f = 100e6 + i * 0.1e6; return { f, ...dutS("filter", f) }; });
    const r = filterAnalysis(d)!;
    expect(r.type).toBe("bandpass");
    expect(r.center! / 1e6).toBeGreaterThan(140);
    expect(r.center! / 1e6).toBeLessThan(150);
  });
  it("analyses a crystal", () => {
    const d = Array.from({ length: 2001 }, (_, i) => { const f = 9.99e6 + i * 20; return { f, ...dutS("crystal", f) }; });
    const r = crystalAnalysis(d)!;
    expect(r.fs / 1e6).toBeCloseTo(10, 3);
    expect(r.rm).toBeCloseTo(20, 0);
    expect(r.lm).toBeCloseTo(0.01, 2);
  });
  it("measures a cable", () => {
    const d = Array.from({ length: 401 }, (_, i) => { const f = 1e6 + i * 0.5e6; return { f, ...dutS("cable", f) }; });
    const r = cableAnalysis(d, 0.66)!;
    expect(r.physicalLength).toBeCloseTo(3, 1);
  });
});

describe("time domain", () => {
  it("fft round-trips", () => {
    const re = new Float64Array([1, 2, 3, 4, 0, 0, 0, 0]), im = new Float64Array(8);
    fft(re, im); fft(re, im, true);
    expect(re[2] / 8).toBeCloseTo(3, 9);
  });
  it("finds the open end of a cable", () => {
    const d = Array.from({ length: 401 }, (_, i) => { const f = (i + 1) * 2.5e6; return { f, ...dutS("cable", f) }; });
    const r = timeDomain(d, "s11", { ...DEFAULT_TDR, enabled: true, mode: "lowpass_impulse" })!;
    let best = 1;
    for (let i = 1; i < r.value.length; i++) if (Math.abs(r.value[i]) > Math.abs(r.value[best])) best = i;
    expect(r.distance[best]).toBeCloseTo(3, 0);
  });
});

describe("files and units", () => {
  const d = [{ f: 1e6, s11: [0.1, 0.2] as Complex, s21: [0.5, -0.5] as Complex }, { f: 2e6, s11: [0.3, -0.1] as Complex, s21: [0.4, 0.1] as Complex }];
  for (const fmt of ["RI", "MA", "DB"] as const) {
    it(`touchstone round-trip ${fmt}`, () => {
      const t = parseTouchstone(writeTouchstone(d, 2, "x", fmt), "a.s2p");
      expect(t.ports).toBe(2);
      expect(t.data[1].f).toBe(2e6);
      expect(t.data[1].s11[0]).toBeCloseTo(0.3, 8);
      expect(t.data[0].s21[1]).toBeCloseTo(-0.5, 8);
    });
  }
  it("parses MHz MA files with comments", () => {
    const t = parseTouchstone("! hi\n# MHz S MA R 50\n100 0.5 90\n200 0.25 -90 ! end\n");
    expect(t.ports).toBe(1);
    expect(t.data[0].f).toBe(100e6);
    expect(t.data[0].s11[1]).toBeCloseTo(0.5, 9);
  });
  it("writes CSV", () => expect(writeCsv(d).split("\n")[0]).toContain("frequency_hz"));
  it("steps scales in 1-2-5", () => {
    expect(stepScale(0.5, 1)).toBe(1);
    expect(stepScale(1, 1)).toBe(2);
    expect(stepScale(2, 1)).toBe(5);
    expect(stepScale(0.5, -1)).toBeCloseTo(0.2, 12);
    expect(stepScale(10, -1)).toBe(5);
    expect(stepScale(1, -1)).toBeCloseTo(0.5, 12);
  });
  it("parses and formats units", () => {
    expect(parseHz("435M")).toBe(435e6);
    expect(parseHz("1.2 GHz")).toBe(1.2e9);
    expect(parseHz("500k")).toBe(500e3);
    expect(si(1.5e-9, "H")).toBe("1.500 nH");
    expect(parseHz("1e400")).toBeNull();
    expect(parseSI("1e400n")).toBeNull();
  });
  it("parseSI is strict about prefixes and trailing text", () => {
    expect(parseSI("12K")).toBe(12e3);
    expect(parseSI("12k")).toBe(12e3);
    expect(parseSI("1.5 m")).toBe(1.5e-3);
    expect(parseSI("2M")).toBe(2e6);
    expect(parseSI("4.7 nH")).toBeCloseTo(4.7e-9, 18);
    expect(parseSI("5 xyz123")).toBeNull();
    expect(parseSI("5#")).toBeNull();
  });
  it("rejects malformed Touchstone rows and bad reference impedances", () => {
    expect(() => parseTouchstone("# HZ S RI R 50\n1 0.5 0 foo\n2 0.5 0\n")).toThrow(/line 2/);
    expect(() => parseTouchstone("# hz s ri r 50\nnot a number\n")).toThrow(/line 2/);
    expect(() => parseTouchstone("# HZ S RI R 50\n1 0.5 0\n2 0.5\n")).toThrow(/Truncated/);
    expect(parseTouchstone("# MHZ S RI R abc\n1 0.5 0\n").z0).toBe(50);
    expect(parseTouchstone("# MHZ S RI R 0\n1 0.5 0\n").z0).toBe(50);
    expect(parseTouchstone("# MHZ S RI R 75\n1 1 0\n").data[0].s11).toEqual([1, 0]); // exact open survives renormalisation
  });
  it("reads wrapped 2-port rows and stops at a noise-parameter block", () => {
    const row = (f: number) => `${f} 0.5 0 0.1 0\n 0.1 0 0.2 0`;
    const wrapped = parseTouchstone(`# MHZ S RI R 50\n${row(1)}\n${row(2)}\n`, "amp.s2p");
    expect(wrapped.data.map((p) => p.f)).toEqual([1e6, 2e6]);
    expect(wrapped.data[1].s21).toEqual([0.1, 0]);
    // Touchstone 1.x noise block: 5 numbers per row, frequency restarts.
    const v1 = `# MHZ S RI R 50\n1 0.5 0 0.1 0 0.1 0 0.2 0\n2 0.5 0 0.1 0 0.1 0 0.2 0\n! noise\n1 1.5 0.3 45 0.2\n2 1.6 0.3 50 0.2\n`;
    expect(parseTouchstone(v1, "amp.s2p").data).toHaveLength(2);
    expect(parseTouchstone(v1.replace(/2 1.6.*\n$/, ""), "amp.s2p").data).toHaveLength(2); // a single short noise row
    const v2 = `[Version] 2.0\n# MHZ S RI R 50\n[Number of Ports] 2\n[Network Data]\n1 0.5 0 0.1 0 0.1 0 0.2 0\n[Noise Data]\n1 1.5 0.3 45 0.2\n[End]\n`;
    expect(parseTouchstone(v2, "amp.s2p").data).toHaveLength(1);
  });
  it("rejects malformed calibration files", () => {
    const base = '"format":"webvna-cal","freqs":[1,2],"open":[[0,0],[0,0]],"short":[[0,0],[0,0]],"load":[[0,0],[0,0]]';
    for (const t of ["null", '{"format":"webvna-cal","freqs":[]}', '{"format":"webvna-cal","freqs":[1,2],"open":[[0,0]]}',
      '{"format":"webvna-cal","freqs":[null,"a"]}', '{"format":"webvna-cal","freqs":[{},{}]}',
      `{${base.replace('"open":[[0,0],[0,0]]', '"open":[null,null]')}}`, `{${base.replace('"open":[[0,0],[0,0]]', '"open":[1,2]')}}`,
      `{${base},"kit":5}`, `{${base},"kit":[]}`])
      expect(() => parseCal(t)).toThrow("Not a WebVNA calibration file.");
    // A partial or null kit is filled from the ideal kit, so the terms can be computed.
    for (const kit of ['{"name":"x"}', "null", '{"open":{"c0":"bad"},"thru":{}}']) {
      const cal = parseCal(`{${base},"thru":[[1,0],[1,0]],"kit":${kit}}`);
      expect(cal.kit.open.c0).toBe(0);
      expect(cal.kit.thru.delayPs).toBe(0);
      expect(() => computeErrorTerms(cal)).not.toThrow();
    }
    for (const extra of ['"enhancedResponse":"false"', '"name":5', '"created":{}'])
      expect(() => parseCal(`{${base},${extra}}`)).toThrow("Not a WebVNA calibration file.");
    expect(() => parseCal(`{${base.replace('"freqs":[1,2]', '"freqs":[2,1]')}}`)).toThrow("Not a WebVNA calibration file."); // descending
    expect(parseCal(`{${base},"kit":{"name":"SMA","open":{"c0":50}}}`).kit).toEqual({ ...IDEAL_KIT, name: "SMA", open: { ...IDEAL_KIT.open, c0: 50 } });
  });
});
