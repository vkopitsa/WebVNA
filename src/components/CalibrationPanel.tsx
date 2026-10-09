import { useState } from "react";
import { useStore, set } from "../store";
import {
  measureStandard, finishCalibration, resetCalibration, clearCalWork, refreshCalTerms, stimulusFromCal, listCalSlots, saveCalSlot,
  loadCalSlot, deleteCalSlot, exportCal, importCalFile, setDeviceCal, recompute, attachStandardFile, detachStandard,
} from "../controller";
import { calCovers, calSummary, IDEAL_KIT, SMA_KIT, type CalKit, type Standard } from "../lib/calibration";
import { Check, Num, Section, Field, SIInput } from "./inputs";
import { SPEED_OF_LIGHT, si } from "../lib/units";
import { useT } from "../i18n";
import { FixtureSection } from "./FixtureSection";
import { TwoPortSection } from "./TwoPortSection";

const STD_LABEL: Record<Standard, string> = { open: "OPEN", short: "SHORT", load: "LOAD", isolation: "ISOLATION", thru: "THRU" };
const STD_HINT: Record<Standard, string> = {
  open: "Open standard on port 1",
  short: "Short standard on port 1",
  load: "50 Ω load on port 1",
  isolation: "Loads on both ports (S21 leakage)",
  thru: "Cable/adapter from port 1 to port 2",
};

export function CalibrationPanel() {
  const s = useStore();
  const t = useT();
  const [slots, setSlots] = useState(() => listCalSlots());
  const [slotName, setSlotName] = useState("");
  const connected = s.status === "connected";
  const work = s.calWork;
  const workMatches = work.freqs && work.freqs.length === s.points && Math.abs(work.freqs[0] - s.start) < 2;

  const kitPatch = (patch: (k: CalKit) => CalKit) => { set({ kit: patch(s.kit) }); setTimeout(refreshCalTerms, 0); };

  return (
    <div>
      <Section title="Calibrate">
        <p className="hint">{t("Connect each standard and press its button. The calibration uses the current sweep settings ({0} points). OPEN, SHORT and LOAD give a full one-port (S11) calibration; add THRU (and ISOLATION) for S21.", s.points)}</p>
        {work.freqs && !workMatches && <p className="hint err-text">{t("The sweep settings changed since the first standard was measured; measuring again starts a new set.")}</p>}
        <div className="grid3">
          {(["open", "short", "load", "isolation", "thru"] as Standard[]).map((std) => (
            <button key={std} disabled={!connected || s.running} title={t(STD_HINT[std])} onClick={() => measureStandard(std)}
              className={work.meas[std] ? "on" : ""}>
              {work.meas[std] ? "✓ " : ""}{t(STD_LABEL[std])}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="primary" disabled={!work.freqs} onClick={() => finishCalibration()}>{t("Done (apply)")}</button>
          <button disabled={!work.freqs} onClick={() => clearCalWork()}>{t("Discard")}</button>
          <button className="danger" disabled={!s.cal} onClick={() => resetCalibration()}>{t("Reset")}</button>
        </div>
        <Check checked={s.enhancedResponse} onChange={(v) => { set({ enhancedResponse: v }); setTimeout(refreshCalTerms, 0); }}>{t("Enhanced response (corrects S21 for port-1 source match)")}</Check>
      </Section>

      <Section title="Active calibration">
        <p className="hint">{s.cal ? calSummary(s.cal) : t("none")}{s.cal?.enhancedResponse ? ` · ${t("enhanced response")}` : ""}</p>
        {s.cal && !calCovers(s.cal, s.start, s.stop) && <p className="hint err-text">{t("The sweep goes outside the calibrated range: error terms at the edges are held constant.")}</p>}
        {s.cal && s.cal.freqs.length !== s.points && calCovers(s.cal, s.start, s.stop) && <p className="hint">{t("Error terms are interpolated onto the current sweep.")}</p>}
        <div className="row">
          <Check checked={s.calEnabled} onChange={(v) => { set({ calEnabled: v }); recompute(); }}>{t("Apply calibration")}</Check>
          <button className="small" disabled={!s.cal} onClick={() => stimulusFromCal()}>{t("Cal range → sweep")}</button>
        </div>
        {(!s.capabilities || s.capabilities.deviceCal) && <Check checked={s.deviceCal} onChange={(v) => void setDeviceCal(v)}>{t("Use device's own calibration (data mode 3)")}</Check>}
      </Section>

      <Section title="Save / recall">
        <div className="row">
          <input type="text" placeholder={t("Name")} value={slotName} onChange={(e) => setSlotName(e.target.value)} aria-label={t("Calibration name")} style={{ flex: 1 }} />
          <button disabled={!s.cal || !slotName} onClick={() => { saveCalSlot(slotName); setSlots(listCalSlots()); }}>{t("Save")}</button>
        </div>
        {slots.map((n) => (
          <div className="row" key={n}>
            <span style={{ flex: 1 }}>{n}</span>
            <button className="small" onClick={() => loadCalSlot(n)}>{t("Recall")}</button>
            <button className="small danger" onClick={() => { deleteCalSlot(n); setSlots(listCalSlots()); }}>✕</button>
          </div>
        ))}
        <div className="row">
          <button disabled={!s.cal} onClick={() => exportCal()}>{t("Export file")}</button>
          <label className="button-like">
            <input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCalFile(f); e.target.value = ""; }} />
            <span style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", color: "var(--fg)", fontSize: 14 }}>{t("Import file")}</span>
          </label>
        </div>
      </Section>

      <Section title="Calibration standard (kit)" right={
        <span className="row" style={{ margin: 0 }}>
          <button className="small" onClick={() => kitPatch(() => IDEAL_KIT)}>{t("Ideal")}</button>
          <button className="small" onClick={() => kitPatch(() => SMA_KIT)}>SMA</button>
        </span>}>
        <div className="grid2">
          <Field label="Open C0 (fF)"><Num value={s.kit.open.c0} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", open: { ...k.open, c0: v } }))} /></Field>
          <Field label="Open C1 (1e-27 F/Hz)"><Num value={s.kit.open.c1} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", open: { ...k.open, c1: v } }))} /></Field>
          <Field label="Open C2 (1e-36 F/Hz²)"><Num value={s.kit.open.c2} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", open: { ...k.open, c2: v } }))} /></Field>
          <Field label="Open C3 (1e-45 F/Hz³)"><Num value={s.kit.open.c3} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", open: { ...k.open, c3: v } }))} /></Field>
          <Field label="Open delay (ps)"><Num value={s.kit.open.delayPs} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", open: { ...k.open, delayPs: v } }))} /></Field>
          <Field label="Short L0 (pH)"><Num value={s.kit.short.l0} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", short: { ...k.short, l0: v } }))} /></Field>
          <Field label="Short L1 (1e-24 H/Hz)"><Num value={s.kit.short.l1} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", short: { ...k.short, l1: v } }))} /></Field>
          <Field label="Short L2 (1e-33 H/Hz²)"><Num value={s.kit.short.l2} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", short: { ...k.short, l2: v } }))} /></Field>
          <Field label="Short L3 (1e-42 H/Hz³)"><Num value={s.kit.short.l3} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", short: { ...k.short, l3: v } }))} /></Field>
          <Field label="Short delay (ps)"><Num value={s.kit.short.delayPs} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", short: { ...k.short, delayPs: v } }))} /></Field>
          <Field label="Load R (Ω)"><Num value={s.kit.load.r} min={0.1} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", load: { ...k.load, r: v } }))} /></Field>
          <Field label="Load L (pH)"><Num value={s.kit.load.lPh} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", load: { ...k.load, lPh: v } }))} /></Field>
          <Field label="Load delay (ps)"><Num value={s.kit.load.delayPs} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", load: { ...k.load, delayPs: v } }))} /></Field>
          <Field label="Thru delay (ps)"><Num value={s.kit.thru.delayPs} onChange={(v) => kitPatch((k) => ({ ...k, name: "Custom", thru: { delayPs: v } }))} /></Field>
        </div>
        <div className="grid3">
          {(["open", "short", "load"] as const).map((std) => {
            const d = s.kit.data?.[std];
            return (
              <div key={std} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {d ? (
                  <span className="row" style={{ margin: 0 }}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", fontSize: 12 }} title={d.name}>{t(STD_LABEL[std])}: {d.name}</span>
                    <button className="small danger" onClick={() => detachStandard(std)} aria-label={t("Remove {0} data", t(STD_LABEL[std]))}>✕</button>
                  </span>
                ) : (
                  <label className="button-like">
                    <input type="file" accept=".s1p,.s2p,.txt" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void attachStandardFile(std, f); e.target.value = ""; }} />
                    <span style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "3px 8px", cursor: "pointer", color: "var(--fg)", fontSize: 12 }}>{t("Load .s1p")} {t(STD_LABEL[std])}</span>
                  </label>
                )}
              </div>
            );
          })}
        </div>
        <p className="hint">{t("A measured Touchstone file replaces the polynomial model of that standard (interpolated onto the sweep).")}</p>
        <p className="hint">{t("Kit: {0}. Changing the kit recomputes the active calibration.", t(s.kit.name))}</p>
      </Section>

      <Section title="Port extension / electrical delay">
        <div className="grid2">
          <Field label="S11 delay"><SIInput value={s.correction.s11Delay} unit="s" onChange={(v) => { set({ correction: { ...s.correction, s11Delay: v } }); recompute(); }} ariaLabel="S11 electrical delay" /></Field>
          <Field label="S21 delay"><SIInput value={s.correction.s21Delay} unit="s" onChange={(v) => { set({ correction: { ...s.correction, s21Delay: v } }); recompute(); }} ariaLabel="S21 electrical delay" /></Field>
          <Field label="S21 offset (dB)"><Num value={s.correction.s21OffsetDb} step={0.1} onChange={(v) => { set({ correction: { ...s.correction, s21OffsetDb: v } }); recompute(); }} ariaLabel="S21 offset" /></Field>
          <Field label="S11 port extension (m, VF)">
            <PortExtension delay={s.correction.s11Delay} onChange={(d) => { set({ correction: { ...s.correction, s11Delay: d } }); recompute(); }} />
          </Field>
        </div>
        <p className="hint">{t("S11 delay is the round-trip time ({0} one way).", si(s.correction.s11Delay / 2, "s"))}</p>
      </Section>

      <FixtureSection />
      <TwoPortSection />
    </div>
  );
}

function PortExtension({ delay, onChange }: { delay: number; onChange: (d: number) => void }) {
  const [vf, setVf] = useState(0.66);
  const len = (delay / 2) * SPEED_OF_LIGHT * vf;
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <Num value={+len.toFixed(4)} step={0.01} onChange={(m) => onChange((2 * m) / (SPEED_OF_LIGHT * vf))} ariaLabel="Port extension length in meters" />
      <Num value={vf} min={0.1} max={1} step={0.01} onChange={setVf} ariaLabel="Velocity factor" />
    </div>
  );
}
