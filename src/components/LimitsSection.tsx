import { useState } from "react";
import { useStore, updateTrace } from "../store";
import { FORMAT_BY_ID } from "../lib/formats";
import { limitsFromBand, type LimitKind, type LimitSegment } from "../lib/limits";
import { exportLimits, importLimitsFile } from "../controller";
import { BANDS } from "./StimulusPanel";
import { Check, FreqInput, Num, Section, Select, Field } from "./inputs";
import { fmtHz } from "../lib/units";
import { useT } from "../i18n";

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
    </Section>
  );
}
