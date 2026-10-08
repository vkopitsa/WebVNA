import { useStore, set, updateTrace, setTraceFormat, MEMORY_SLOTS, type MemorySlot } from "../store";
import { FORMATS, FORMAT_BY_ID } from "../lib/formats";
import { Check, Num, Section, Select, Field, SIInput } from "./inputs";
import { storeMemory, clearMemory, updateMarkers } from "../controller";
import { rectSeries } from "../display";
import type { TdrMode, TdrWindow } from "../lib/tdr";
import { PADDINGS } from "../lib/tdr";
import { LimitsSection } from "./LimitsSection";
import { GateSection } from "./GateSection";
import { useT } from "../i18n";

export function DisplayPanel() {
  const s = useStore();
  const tl = useT();
  const t = s.traces[s.activeTrace];
  const fd = FORMAT_BY_ID[t.format];
  const autoNow = () => {
    const se = rectSeries(s).series.find((x) => x.traceIndex === s.activeTrace && x.primary);
    if (se) updateTrace(s.activeTrace, { scale: { ...se.scale, auto: false } });
  };

  return (
    <div>
      <Section title="Traces">
        {s.traces.map((tr, i) => (
          <div key={i} className="row trace-row" style={{ background: i === s.activeTrace ? "var(--panel2)" : undefined, borderRadius: 6, padding: "2px 4px" }}>
            <input type="checkbox" checked={tr.enabled} onChange={(e) => updateTrace(i, { enabled: e.target.checked })} aria-label={tl("Trace {0} on", i + 1)} />
            <button className={"small" + (i === s.activeTrace ? " on" : "")} onClick={() => set({ activeTrace: i })}>TR{i + 1}</button>
            <Select value={tr.channel} options={[["s11", "S11"], ["s21", "S21"], ["s12", "S12"], ["s22", "S22"]]} onChange={(v) => updateTrace(i, { channel: v })} ariaLabel={tl("Trace {0} channel", i + 1)} />
            <Select className="fmt" value={tr.format} options={FORMATS.map((f) => [f.id, tl(f.label)] as [typeof f.id, string])} onChange={(v) => setTraceFormat(i, v)} ariaLabel={tl("Trace {0} format", i + 1)} />
            <input type="color" value={tr.color} onChange={(e) => updateTrace(i, { color: e.target.value })} aria-label={tl("Trace {0} colour", i + 1)} />
          </div>
        ))}
      </Section>

      {!fd.circular && (
        <Section title={tl("Scale — TR{0}", s.activeTrace + 1)}>
          <div className="row">
            <Check checked={t.scale.auto} onChange={(v) => (v ? updateTrace(s.activeTrace, { scale: { ...t.scale, auto: true } }) : autoNow())}>{tl("Auto scale")}</Check>
            <button className="small" onClick={autoNow}>{tl("Auto once")}</button>
            <button className="small" onClick={() => setTraceFormat(s.activeTrace, t.format)}>{tl("Default")}</button>
          </div>
          <div className="grid3">
            <Field label={tl("Scale/div {0}", fd.unit)}><SIInput value={t.scale.perDiv} onChange={(v) => v > 0 && updateTrace(s.activeTrace, { scale: { ...t.scale, perDiv: v, auto: false } })} ariaLabel="Scale per division" /></Field>
            <Field label={tl("Ref value {0}", fd.unit)}><SIInput value={t.scale.ref} onChange={(v) => updateTrace(s.activeTrace, { scale: { ...t.scale, ref: v, auto: false } })} ariaLabel="Reference value" /></Field>
            <Field label="Ref position (div)"><Num value={t.scale.refPos} min={0} max={8} step={1} onChange={(v) => updateTrace(s.activeTrace, { scale: { ...t.scale, refPos: v, auto: false } })} ariaLabel="Reference position" /></Field>
          </div>
          <p className="hint">{tl("Double-click the chart to auto-scale all traces.")}</p>
        </Section>
      )}

      <LimitsSection />

      <Section title="Memory (stored traces)">
        <div className="grid4">
          {MEMORY_SLOTS.map((m) => (
            <div key={m} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <button className="small" onClick={() => storeMemory(m)} title={tl("Store current data in memory {0}", m)}>{tl("Store {0}", m)}</button>
              <button className="small" disabled={!s.memories[m]} onClick={() => clearMemory(m)}>{tl("Clear {0}", m)}</button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <label>{tl("TR{0} shows", s.activeTrace + 1)}</label>
          <Select value={t.memory ?? "-"} ariaLabel="Memory overlay"
            options={[["-", tl("No memory")], ...MEMORY_SLOTS.filter((m) => s.memories[m]).map((m) => [m, tl("Memory {0}", m)] as [string, string])]}
            onChange={(v) => updateTrace(s.activeTrace, { memory: v === "-" ? null : (v as MemorySlot), math: v === "-" ? "off" : t.math })} />
          <Select value={t.math} ariaLabel="Trace math" options={[["off", tl("Data + memory")], ["subtract", tl("Data / memory")]]}
            onChange={(v) => updateTrace(s.activeTrace, { math: t.memory ? v : "off" })} />
        </div>
      </Section>

      <Section title="Reference files">
        {s.refs.length === 0 && <p className="hint">{tl("Import .s1p/.s2p files on the Files tab to overlay them on the active trace.")}</p>}
        {s.refs.map((r, i) => (
          <div key={i} className="row">
            <input type="checkbox" checked={r.visible} onChange={(e) => set({ refs: s.refs.map((x, k) => (k === i ? { ...x, visible: e.target.checked } : x)) })} aria-label={tl("Show {0}", r.name)} />
            <input type="color" value={r.color} onChange={(e) => set({ refs: s.refs.map((x, k) => (k === i ? { ...x, color: e.target.value } : x)) })} aria-label={tl("{0} colour", r.name)} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }} title={r.name}>{r.name}</span>
            <button className="small danger" onClick={() => set({ refs: s.refs.filter((_, k) => k !== i) })}>✕</button>
          </div>
        ))}
      </Section>

      <Section title="Time domain (TDR / DTF)">
        <Check checked={s.tdr.enabled} onChange={(v) => set({ tdr: { ...s.tdr, enabled: v } })}>{tl("Transform rectangular traces to time domain")}</Check>
        <div className="grid2" style={{ marginTop: 6 }}>
          <Field label="Mode">
            <Select value={s.tdr.mode} ariaLabel="Transform mode" options={[["lowpass_impulse", tl("Low-pass impulse")], ["lowpass_step", tl("Low-pass step")], ["bandpass", tl("Band-pass")]] as [TdrMode, string][]}
              onChange={(v) => set({ tdr: { ...s.tdr, mode: v } })} />
          </Field>
          <Field label="Window">
            <Select value={s.tdr.window} ariaLabel="Window" options={[["minimum", tl("Minimum (rect)")], ["normal", tl("Normal (Kaiser 6)")], ["maximum", tl("Maximum (Kaiser 13)")]] as [TdrWindow, string][]}
              onChange={(v) => set({ tdr: { ...s.tdr, window: v } })} />
          </Field>
          <Field label="Velocity factor"><Num value={s.tdr.velocityFactor} min={0.1} max={1} step={0.01} onChange={(v) => set({ tdr: { ...s.tdr, velocityFactor: v } })} /></Field>
          <Field label="Max distance (m, 0 = all)"><Num value={s.tdr.maxDistance} min={0} step={1} onChange={(v) => set({ tdr: { ...s.tdr, maxDistance: v } })} /></Field>
          <Field label="X axis">
            <Select value={s.tdr.xAxis} ariaLabel="X axis" options={[["distance", tl("Distance")], ["time", tl("Time")]]} onChange={(v) => set({ tdr: { ...s.tdr, xAxis: v } })} />
          </Field>
          <Field label="Padding">
            <Select value={s.tdr.padding} ariaLabel="Zero padding" options={PADDINGS.map((p) => [p, `×${p}`] as [number, string])} onChange={(v) => set({ tdr: { ...s.tdr, padding: v } })} />
          </Field>
          <Field label="Y axis">
            <Select value={s.tdr.yAxis} ariaLabel="Y axis" options={[["linear", tl("Linear ρ")], ["db", "dB"], ["impedance", tl("Impedance (step)")]]} onChange={(v) => set({ tdr: { ...s.tdr, yAxis: v } })} />
          </Field>
        </div>
        <p className="hint">{tl("Low-pass modes need a sweep that starts near 0 Hz with evenly spaced points (e.g. 50 kHz – 1 GHz); the data is resampled onto a harmonic grid.")}</p>
      </Section>

      <GateSection />

      {s.traces.some((x) => x.format === "mu_r" || x.format === "mu_i") && (
        <Section title="Core (µ′ / µ″)">
          <div className="grid3">
            <Field label="Turns"><Num value={s.core.turns} min={1} step={1} onChange={(v) => { set({ core: { ...s.core, turns: v } }); updateMarkers(); }} ariaLabel="Core turns" /></Field>
            <Field label="Area (mm²)"><Num value={s.core.areaMm2} min={0.01} step={0.1} onChange={(v) => { set({ core: { ...s.core, areaMm2: v } }); updateMarkers(); }} ariaLabel="Core cross-section area" /></Field>
            <Field label="Path (mm)"><Num value={s.core.pathMm} min={0.1} step={0.1} onChange={(v) => { set({ core: { ...s.core, pathMm: v } }); updateMarkers(); }} ariaLabel="Core magnetic path length" /></Field>
          </div>
          <p className="hint">{tl("Toroid wound with the given turns on the S11 port: µ′ = X/(ωL₀), µ″ = R/(ωL₀), L₀ = µ₀N²A/l. The default approximates an FT-37-43 core.")}</p>
        </Section>
      )}

      <Section title="Charts">
        <Check checked={s.showRect} onChange={(v) => set({ showRect: v })}>{tl("Rectangular chart")}</Check>{" "}
        <Check checked={s.showSmith} onChange={(v) => set({ showSmith: v })}>{tl("Smith / polar chart")}</Check>
      </Section>
    </div>
  );
}
