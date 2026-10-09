import { useStore, log } from "../store";
import { setFixture } from "../controller";
import { fixtureFromTouchstone, flip, type FixtureOp, type FixtureSettings, type FixtureStage, type LumpedElement, type LumpedKind } from "../lib/deembed";
import { Check, Field, Num, Section, Select, SIInput } from "./inputs";
import { tr, useT } from "../i18n";

type PortKey = "port1" | "port2";

const UNIT: Record<LumpedElement, string> = { R: "Ω", L: "H", C: "F" };
const DEFAULT_LUMPED: FixtureStage = { type: "lumped", op: "deembed", kind: "series", element: "L", value: 1e-9 };
const DEFAULT_LINE: FixtureStage = { type: "line", op: "deembed", z0: 50, lengthM: 0.01, vf: 0.66, lossDbPerM: 0 };

export function FixtureSection() {
  const fx = useStore((s) => s.fixture);
  const t = useT();

  const edit = (patch: Partial<FixtureSettings>) => setFixture({ ...fx, ...patch });
  const editPort = (port: PortKey, fn: (l: FixtureStage[]) => FixtureStage[]) => edit({ [port]: fn(fx[port]) });
  const editStage = (port: PortKey, i: number, patch: Partial<FixtureStage>) =>
    editPort(port, (l) => l.map((st, k) => (k === i ? ({ ...st, ...patch } as FixtureStage) : st)));
  const move = (port: PortKey, i: number, d: -1 | 1) =>
    editPort(port, (l) => { const j = i + d; if (j < 0 || j >= l.length) return l; const o = l.slice(); [o[i], o[j]] = [o[j], o[i]]; return o; });

  const addFile = async (port: PortKey, file: File) => {
    try { const st = fixtureFromTouchstone(await file.text(), file.name); editPort(port, (l) => [...l, st]); }
    catch (e) { log(tr("Import {0}: {1}", file.name, e instanceof Error ? e.message : String(e)), "error"); }
  };

  const stageRow = (port: PortKey, st: FixtureStage, i: number, n: number) => (
    <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 4, marginBottom: 4 }}>
      <div className="row" style={{ margin: 0 }}>
        <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }} title={st.type === "file" ? st.name : undefined}>
          {i + 1}. {st.type === "file" ? st.name : st.type === "lumped" ? t("Lumped element") : t("Transmission line")}
        </span>
        <Select value={st.op} ariaLabel="Fixture operation" options={[["deembed", "De-embed"], ["embed", "Embed"]] as [FixtureOp, string][]} onChange={(v) => editStage(port, i, { op: v })} />
        <button className="small" disabled={i === 0} onClick={() => move(port, i, -1)} aria-label={t("Move stage up")}>↑</button>
        <button className="small" disabled={i === n - 1} onClick={() => move(port, i, 1)} aria-label={t("Move stage down")}>↓</button>
        <button className="small danger" onClick={() => editPort(port, (l) => l.filter((_, k) => k !== i))} aria-label={t("Remove stage")}>✕</button>
      </div>
      {st.type === "lumped" && (
        <div className="grid3">
          <Field label="Connection"><Select value={st.kind} ariaLabel="Lumped connection" options={[["series", "Series"], ["shunt", "Shunt"]] as [LumpedKind, string][]} onChange={(v) => editStage(port, i, { kind: v })} /></Field>
          <Field label="Element"><Select value={st.element} ariaLabel="Lumped element" options={["R", "L", "C"] as LumpedElement[]} onChange={(v) => editStage(port, i, { element: v })} /></Field>
          <Field label="Value"><SIInput value={st.value} unit={UNIT[st.element]} ariaLabel="Lumped value" onChange={(v) => v > 0 && editStage(port, i, { value: v })} /></Field>
        </div>
      )}
      {st.type === "line" && (
        <div className="grid2">
          <Field label="Z0 (Ω)"><Num value={st.z0} min={1} onChange={(v) => editStage(port, i, { z0: v })} ariaLabel="Line impedance" /></Field>
          <Field label="Length"><SIInput value={st.lengthM} unit="m" ariaLabel="Line length" onChange={(v) => v >= 0 && editStage(port, i, { lengthM: v })} /></Field>
          <Field label="Velocity factor"><Num value={st.vf} min={0.1} max={1} step={0.01} onChange={(v) => editStage(port, i, { vf: v })} ariaLabel="Line velocity factor" /></Field>
          <Field label="Loss (dB/m at 1 GHz)"><Num value={st.lossDbPerM ?? 0} min={0} step={0.1} onChange={(v) => editStage(port, i, { lossDbPerM: v })} ariaLabel="Line loss" /></Field>
        </div>
      )}
      {st.type === "file" && (
        <div className="row" style={{ margin: "4px 0 0" }}>
          <span className="hint" style={{ flex: 1 }}>{t("{0} points", st.points.length)}</span>
          <button className="small" title={t("Swap the file's port 1 and port 2")}
            onClick={() => editStage(port, i, { points: st.points.map((p) => ({ f: p.f, s: flip(p.s) })) })}>{t("Flip orientation")}</button>
        </div>
      )}
    </div>
  );

  const portBlock = (port: PortKey, title: string) => (
    <div style={{ marginTop: 8 }}>
      <label style={{ fontWeight: 600 }}>{t(title)}</label>
      {fx[port].length === 0 && <p className="hint">{t("No stages.")}</p>}
      {fx[port].map((st, i) => stageRow(port, st, i, fx[port].length))}
      <div className="row">
        <button className="small" onClick={() => editPort(port, (l) => [...l, DEFAULT_LUMPED])}>+ {t("Lumped")}</button>
        <button className="small" onClick={() => editPort(port, (l) => [...l, DEFAULT_LINE])}>+ {t("Line")}</button>
        <label className="button-like">
          <input type="file" accept=".s2p,.S2P,.txt" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void addFile(port, f); e.target.value = ""; }} />
          <span style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "3px 8px", cursor: "pointer", color: "var(--fg)", fontSize: 12 }}>{t("Load .s2p")}</span>
        </label>
      </div>
    </div>
  );

  return (
    <Section title="Fixture (de-embed / embed)">
      <Check checked={fx.enabled} onChange={(v) => edit({ enabled: v })}>{t("Apply fixture")}</Check>
      {portBlock("port1", "Port 1")}
      {portBlock("port2", "Port 2")}
      <div className="grid2" style={{ marginTop: 8 }}>
        <Field label="Renormalize to Z0 (Ω)">
          <Num value={fx.z0 ?? 50} min={1} onChange={(v) => edit({ z0: v === 50 ? undefined : v })} ariaLabel="Renormalize to impedance" />
        </Field>
      </div>
      <p className="hint">{t("Stages are listed from the instrument toward the DUT and applied in that order. De-embed removes a network between the calibration plane and the DUT; embed adds one (fixture simulation). A file's port 1 faces the instrument on port 1 and the DUT on port 2; use Flip orientation if it is the other way round. Z0 = 50 means no renormalization.")}</p>
      <p className="hint">{t("Without full 2-port data, S21 is corrected approximately (fixture reflections neglected). Use the flip-DUT 2-port measurement for exact results.")}</p>
    </Section>
  );
}
