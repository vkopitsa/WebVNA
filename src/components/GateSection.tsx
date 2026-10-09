import { useState } from "react";
import { useStore } from "../store";
import { setGate, gateAroundPeak } from "../controller";
import { canGate, distanceToTime, gateTimeAxis } from "../lib/gating";
import type { TdrWindow } from "../lib/tdr";
import { SPEED_OF_LIGHT, si } from "../lib/units";
import { Check, Field, Num, Section, Select, SIInput } from "./inputs";
import { useT } from "../i18n";

export function GateSection() {
  const s = useStore();
  const t = useT();
  const g = s.gate;
  const [inMeters, setInMeters] = useState(false);
  const rt = g.channel !== "s21"; // reflections travel the path twice
  const vf = s.tdr.velocityFactor;
  const toM = (sec: number) => (sec * SPEED_OF_LIGHT * vf) / (rt ? 2 : 1);
  const fromM = (m: number) => distanceToTime(m, vf, rt);
  const axis = s.data.length ? gateTimeAxis(s.data) : null;
  const ok = !s.data.length || canGate(s.data);

  return (
    <Section title="Time gating">
      <Check checked={g.enabled} onChange={(v) => setGate({ enabled: v })}>{t("Gate the sweep in the time domain")}</Check>
      <div className="grid2" style={{ marginTop: 6 }}>
        <Field label="Channel"><Select value={g.channel} ariaLabel="Gate channel" options={[["s11", "S11"], ["s21", "S21"], ["both", t("Both")]]} onChange={(v) => setGate({ channel: v })} /></Field>
        <Field label="Type"><Select value={g.type} ariaLabel="Gate type" options={[["bandpass", t("Band-pass (keep)")], ["notch", t("Notch (remove)")]]} onChange={(v) => setGate({ type: v })} /></Field>
        <Field label={inMeters ? "Centre (m)" : "Centre"}>
          {inMeters ? <Num value={+toM(g.center).toFixed(4)} step={0.1} onChange={(v) => setGate({ center: fromM(v) })} ariaLabel="Gate centre in metres" />
            : <SIInput value={g.center} unit="s" onChange={(v) => setGate({ center: v })} ariaLabel="Gate centre" />}
        </Field>
        <Field label={inMeters ? "Span (m)" : "Span"}>
          {inMeters ? <Num value={+toM(g.span).toFixed(4)} min={0} step={0.1} onChange={(v) => v > 0 && setGate({ span: fromM(v) })} ariaLabel="Gate span in metres" />
            : <SIInput value={g.span} unit="s" onChange={(v) => v > 0 && setGate({ span: v })} ariaLabel="Gate span" />}
        </Field>
        <Field label="Edges">
          <Select value={g.window} ariaLabel="Gate window" options={[["minimum", t("Minimum (rect)")], ["normal", t("Normal (Kaiser 6)")], ["maximum", t("Maximum (Kaiser 13)")]] as [TdrWindow, string][]}
            onChange={(v) => setGate({ window: v })} />
        </Field>
        <Field label="Units"><Select value={inMeters ? "m" : "s"} ariaLabel="Gate units" options={[["s", t("Time")], ["m", t("Distance (m)")]]} onChange={(v) => setInMeters(v === "m")} /></Field>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="small" disabled={!s.raw.length} onClick={gateAroundPeak}>{t("Gate around TDR peak")}</button>
      </div>
      {!ok && <p className="hint err-text">{t("Gating needs a linear sweep with evenly spaced points (not log); the gate is ignored.")}</p>}
      <p className="hint">{t("Time 0 is the reference plane; S11 times are round trip. Distances use the velocity factor from the TDR settings ({0}).", vf)}{axis && axis.tMax > 0 ? ` ${t("Unambiguous up to {0}.", si(axis.tMax, "s"))}` : ""}</p>
    </Section>
  );
}
