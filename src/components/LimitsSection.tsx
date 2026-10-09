import { useState } from "react";
import { useStore, updateTrace } from "../store";
import { FORMAT_BY_ID } from "../lib/formats";
import { limitsFromBand, type LimitKind, type LimitSegment } from "../lib/limits";
import { exportLimits, importLimitsFile } from "../controller";
import { BANDS } from "./StimulusPanel";
import { Check, FreqInput, Num, Section, Select, Field } from "./inputs";
import { fmtHz } from "../lib/units";
import { useT } from "../i18n";
import { filterMask, rippleIn, s21Db } from "../lib/rftests";

/** Sensible starting limit for a format: [kind, value]. */
function defaultLimit(format: string, channel: string): [LimitKind, number] {
  switch (format) {
    case "swr": return ["upper", 1.5];
    case "rl": return ["lower", 10];
    case "mismatch": return ["upper", 0.5];
    case "logmag": case "s21gain": return channel === "s11" ? ["upper", -10] : ["lower", -3];
    default: return ["upper", 0];
  }
}

export function LimitsSection() {
  const s = useStore();
  const t = useT();
  const tc = s.traces[s.activeTrace];
  const ti = s.activeTrace;
  const [kindSel, setKind] = useState<LimitKind | null>(null);
  const [valSel, setVal] = useState<number | null>(null);
  if (FORMAT_BY_ID[tc.format].circular) return null;
  const [dKind, dVal] = defaultLimit(tc.format, tc.channel);
  const kind = kindSel ?? dKind, val = valSel ?? dVal;
  const segs = tc.limits;
  const setSegs = (l: LimitSegment[]) => updateTrace(ti, { limits: l });
  const patch = (i: number, p: Partial<LimitSegment>) => setSegs(segs.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const unit = FORMAT_BY_ID[tc.format].unit;
  const kinds: [LimitKind, string][] = [["upper", t("Upper (max)")], ["lower", t("Lower (min)")]];

  return (
    <Section title={t("Limits (pass/fail) — TR{0}", ti + 1)}>
      {segs.length === 0 && <p className="hint">{t("Limit lines are checked against the trace on every sweep and shown on the chart with a PASS/FAIL badge.")}</p>}
      {segs.map((l, i) => (
        <div key={i} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 4, marginBottom: 4 }}>
          <div className="row">
            <input type="checkbox" checked={l.enabled !== false} onChange={(e) => patch(i, { enabled: e.target.checked })} aria-label={t("Segment {0} on", i + 1)} />
            <Select value={l.kind} options={kinds} onChange={(v) => patch(i, { kind: v })} ariaLabel="Limit kind" />
            <span style={{ flex: 1 }} />
            <button className="small danger" onClick={() => setSegs(segs.filter((_, k) => k !== i))} aria-label={t("Delete segment {0}", i + 1)}>✕</button>
          </div>
          <div className="grid2">
            <Field label="From"><FreqInput value={l.f1} onChange={(v) => patch(i, { f1: v })} ariaLabel="Limit start frequency" /></Field>
            <Field label="To"><FreqInput value={l.f2} onChange={(v) => patch(i, { f2: v })} ariaLabel="Limit stop frequency" /></Field>
            <Field label={t("Value 1 {0}", unit)}><Num value={l.v1} step={0.1} onChange={(v) => patch(i, { v1: v })} ariaLabel="Limit value at start" /></Field>
            <Field label={t("Value 2 {0}", unit)}><Num value={l.v2} step={0.1} onChange={(v) => patch(i, { v2: v })} ariaLabel="Limit value at stop" /></Field>
          </div>
        </div>
      ))}
      <div className="row">
        <Select value={kind} options={kinds} onChange={setKind} ariaLabel="New limit kind" />
        <Num value={val} step={0.1} onChange={setVal} ariaLabel="New limit value" />
        <span className="hint">{unit}</span>
      </div>
      <div className="row">
        <button className="small" onClick={() => setSegs([...segs, limitsFromBand(s.start, s.stop, kind, val)])}>{t("From current band")}</button>
        <button className="small" onClick={() => setSegs([...segs, limitsFromBand(Math.round(s.start + (s.stop - s.start) / 3), Math.round(s.start + (2 * (s.stop - s.start)) / 3), kind, val)])}>{t("Add segment")}</button>
        <Select value="-" ariaLabel="Band preset for limit" options={[["-", t("From band preset…")], ...BANDS.map(([n]) => [n, t(n)] as [string, string])]}
          onChange={(n) => {
            const b = BANDS.find((x) => x[0] === n);
            if (b) setSegs([...segs, limitsFromBand(b[1], b[2], kind, val)]);
          }} />
      </div>
      <div className="row">
        <button className="small" disabled={!segs.length} onClick={() => exportLimits(ti)}>{t("Save limits")}</button>
        <label className="button-like">
          <input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importLimitsFile(ti, f); e.target.value = ""; }} />
          <span style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "3px 8px", cursor: "pointer", color: "var(--fg)", fontSize: 12 }}>{t("Load limits")}</span>
        </label>
        <button className="small danger" disabled={!segs.length} onClick={() => setSegs([])}>{t("Clear")}</button>
      </div>
      {segs.length > 0 && <p className="hint">{t("Limits apply in the frequency domain, in the units of the trace ({0}). Band: {1} – {2}.", unit || t("unitless"), fmtHz(s.start), fmtHz(s.stop))}</p>}
      <Check checked={segs.length > 0 && segs.every((l) => l.enabled !== false)} onChange={(v) => setSegs(segs.map((l) => ({ ...l, enabled: v })))}>{t("All segments on")}</Check>
      {tc.channel === "s21" && (tc.format === "logmag" || tc.format === "s21gain") && <FilterMask ti={ti} />}
    </Section>
  );
}

function FilterMask({ ti }: { ti: number }) {
  const t = useT();
  const start = useStore((s) => s.start), stop = useStore((s) => s.stop), data = useStore((s) => s.data);
  const [open, setOpen] = useState(false);
  const [m, setM] = useState(() => {
    const w = stop - start;
    return { passLo: start + 0.4 * w, passHi: start + 0.6 * w, maxIl: 3, maxRipple: 1, stopLo: (start + 0.2 * w) as number | null, stopHi: (start + 0.8 * w) as number | null, minRej: 40 };
  });
  const p = (q: Partial<typeof m>) => setM({ ...m, ...q });
  const ripple = data.length ? rippleIn(data.map((x) => x.f), data.map((x) => s21Db(x.s21)), m.passLo, m.passHi) : null;
  if (!open) return <button className="small" onClick={() => setOpen(true)}>{t("Filter mask…")}</button>;
  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 4, marginTop: 4 }}>
      <p className="hint">{t("Builds limit lines: passband loss at most the max IL, stopbands at least the min rejection below 0 dB. Untick a stopband edge for a one-sided mask.")}</p>
      <div className="grid2">
        <Field label="Passband from"><FreqInput value={m.passLo} onChange={(v) => p({ passLo: v })} ariaLabel="Passband start" /></Field>
        <Field label="Passband to"><FreqInput value={m.passHi} onChange={(v) => p({ passHi: v })} ariaLabel="Passband stop" /></Field>
        <Field label="Max IL (dB)"><Num value={m.maxIl} min={0} step={0.1} onChange={(v) => p({ maxIl: v })} /></Field>
        <Field label="Max ripple (dB)"><Num value={m.maxRipple} min={0} step={0.1} onChange={(v) => p({ maxRipple: v })} /></Field>
        <Field label="Lower stopband edge"><Check checked={m.stopLo != null} onChange={(v) => p({ stopLo: v ? start + 0.2 * (stop - start) : null })}>{m.stopLo != null ? "" : t("off")}</Check>{m.stopLo != null && <FreqInput value={m.stopLo} onChange={(v) => p({ stopLo: v })} ariaLabel="Lower stopband edge" />}</Field>
        <Field label="Upper stopband edge"><Check checked={m.stopHi != null} onChange={(v) => p({ stopHi: v ? start + 0.8 * (stop - start) : null })}>{m.stopHi != null ? "" : t("off")}</Check>{m.stopHi != null && <FreqInput value={m.stopHi} onChange={(v) => p({ stopHi: v })} ariaLabel="Upper stopband edge" />}</Field>
        <Field label="Min rejection (dB)"><Num value={m.minRej} min={0} step={1} onChange={(v) => p({ minRej: v })} /></Field>
      </div>
      {ripple != null && <p className="hint" style={{ color: ripple <= m.maxRipple ? "var(--ok)" : "var(--err)", fontWeight: 600 }}>{t("Passband ripple {0} dB (max {1}): {2}", ripple.toFixed(2), m.maxRipple, ripple <= m.maxRipple ? "PASS" : "FAIL")}</p>}
      <div className="row">
        <button className="small primary" onClick={() => updateTrace(ti, { limits: filterMask({ ...m, fMin: start, fMax: stop }) })}>{t("Apply mask (replaces limits)")}</button>
        <button className="small" onClick={() => setOpen(false)}>{t("Close")}</button>
      </div>
    </div>
  );
}
