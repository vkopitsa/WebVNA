import { useMemo } from "react";
import { traceData, valueText, limitReports } from "../display";
import { traceStats } from "../lib/stats";
import { useStore, set, type MeasureMode } from "../store";
import { Num, Section, Select } from "./inputs";
import { cableAnalysis, crystalAnalysis, filterAnalysis, lcMatch, lcResonator, nearestIndex, resonances, swrBandwidth } from "../lib/analysis";
import { FORMAT_BY_ID, impedance, swr, traceValues } from "../lib/formats";
import { C } from "../lib/complex";
import { fmtHz, si } from "../lib/units";
import { useT, translate, type Lang } from "../i18n";

const MODES: [MeasureMode, string, string][] = [
  ["off", "Off", ""],
  ["lcmatch", "L/C match", "S11: L-networks that match the load at the active marker to 50 Ω."],
  ["resonance", "Resonances", "S11: frequencies where reactance crosses zero (series and parallel resonance)."],
  ["cable", "Cable (S11)", "Connect a cable open or shorted at the far end to port 1. Length from group delay, loss from |S11|."],
  ["filter", "Filter (S21)", "Connect the filter between port 1 and port 2: insertion loss, −3/−6/−60 dB bandwidth, Q, shape factor."],
  ["serieslc", "Series LC (S21)", "Series LC in the through path between the ports: resonance, R, L, C, Q."],
  ["shuntlc", "Shunt LC (S21)", "Series LC from the through line to ground: notch frequency, R, L, C, Q."],
  ["xtal", "Series crystal (S21)", "Crystal in series between the ports: fs, fp, motional Rm, Lm, Cm, holder Cp, Q."],
  ["stats", "Statistics", "Min, max, mean, deviation, peak-to-peak, slope and flatness of the active trace between markers 1 and 2 (the whole sweep when fewer than two of them are on)."],
];

export function MeasurePanel() {
  const mode = useStore((s) => s.measure);
  const vf = useStore((s) => s.measureVf);
  const t = useT();
  return (
    <div>
      <Section title="Measure">
        <Select value={mode} ariaLabel="Measurement" options={MODES.map(([v, l]) => [v, t(l)] as [MeasureMode, string])} onChange={(v) => set({ measure: v })} />
        <p className="hint">{t(MODES.find((m) => m[0] === mode)?.[2] ?? "")}</p>
        {mode === "cable" && <div className="row"><label>{t("Velocity factor")}</label><Num value={vf} min={0.1} max={1} step={0.01} onChange={(v) => set({ measureVf: v })} /></div>}
        <p className="hint">{t("Results are shown under the charts and update with every sweep.")}</p>
      </Section>
    </div>
  );
}

/** Antenna summary plus the selected MEASURE function. */
export function AnalysisBox() {
  const data = useStore((s) => s.data);
  const mode = useStore((s) => s.measure);
  const vf = useStore((s) => s.measureVf);
  const markers = useStore((s) => s.markers);
  const activeMarker = useStore((s) => s.activeMarker);
  const lang = useStore((s) => s.lang);
  const traces = useStore((s) => s.traces);
  const activeTrace = useStore((s) => s.activeTrace);
  const memories = useStore((s) => s.memories);
  const core = useStore((s) => s.core);
  const tdrOn = useStore((s) => s.tdr.enabled);
  const t = useT();
  const mf = markers[activeMarker]?.f ?? 0;

  const content = useMemo(() => {
    const tr = (s: string, ...a: (string | number)[]) => translate(lang as Lang, s, ...a);
    if (!data.length) return <p className="hint">{tr("No data yet.")}</p>;
    const reports = tdrOn ? [] : limitReports({ data, memories, core, traces });
    const limits = reports.length > 0 && (
      <div className="kv" style={{ marginBottom: 8 }}>
        {reports.map((r) => <span key={r.index} style={{ gridColumn: "1 / -1", fontWeight: 600, color: r.status === "pass" ? "var(--ok)" : r.status === "fail" ? "var(--err)" : "var(--warn)" }}>{r.text}</span>)}
      </div>
    );
    const band = swrBandwidth(data);
    const best = band ? data[band.best] : null;
    const zb = best ? impedance(best.s11, "s11") : null;
    const summary = best && zb && (
      <div className="kv" style={{ marginBottom: 8 }}>
        <span>{tr("Best match")}</span><span>{fmtHz(best.f)} · {tr("VSWR {0}", swr(best.s11).toFixed(3))} · {zb[0].toFixed(1)} {zb[1] >= 0 ? "+" : "−"} j{Math.abs(zb[1]).toFixed(1)} Ω</span>
        <span>{tr("VSWR < 2")}</span><span>{band?.bw ? `${fmtHz(band.low!)} – ${fmtHz(band.high!)} (${si(band.bw, "Hz")}, ${band.pct!.toFixed(2)} %)` : tr("none in this sweep")}</span>
        <span>{tr("Return loss")}</span><span>{tr("{0} dB · mismatch loss {1} dB", (-20 * Math.log10(Math.max(C.abs(best.s11), 1e-12))).toFixed(2), (-10 * Math.log10(1 - Math.min(C.abs(best.s11), 0.9999) ** 2)).toFixed(3))}</span>
      </div>
    );
    let extra: React.ReactNode = null;
    if (mode === "lcmatch") {
      const p = data[nearestIndex(data, mf)];
      const z = impedance(p.s11, "s11");
      const sols = lcMatch(z, p.f);
      extra = (
        <>
          <p className="hint">{tr("At M{0} {1}: Z = {2} {3} j{4} Ω", activeMarker + 1, fmtHz(p.f), z[0].toFixed(2), z[1] >= 0 ? "+" : "−", Math.abs(z[1]).toFixed(2))}</p>
          {sols.length ? (
            <table className="data"><thead><tr><th>{tr("Topology")}</th><th>{tr("Source shunt")}</th><th>{tr("Series")}</th><th>{tr("Load shunt")}</th></tr></thead>
              <tbody>{sols.map((x, i) => <tr key={i}><td>{x.topology}</td><td>{x.source}</td><td>{x.series}</td><td>{x.load}</td></tr>)}</tbody></table>
          ) : <p className="hint">{tr("No L-network solution (R ≤ 0).")}</p>}
        </>
      );
    } else if (mode === "resonance") {
      const r = resonances(data);
      extra = r.length ? (
        <table className="data"><thead><tr><th>{tr("Frequency")}</th><th>{tr("Type")}</th><th>R</th></tr></thead>
          <tbody>{r.slice(0, 20).map((x, i) => <tr key={i}><td>{fmtHz(x.f)}</td><td>{tr(x.kind)}</td><td>{x.r.toFixed(2)} Ω</td></tr>)}</tbody></table>
      ) : <p className="hint">{tr("No reactance zero crossing in this sweep.")}</p>;
    } else if (mode === "cable") {
      const r = cableAnalysis(data, vf);
      extra = r && (
        <div className="kv">
          <span>{tr("Physical length")}</span><span>{tr("{0} m (VF {1})", r.physicalLength.toFixed(3), vf)}</span>
          <span>{tr("Electrical length")}</span><span>{r.electricalLength.toFixed(3)} m</span>
          <span>{tr("One-way delay")}</span><span>{si(r.delay, "s")}</span>
          <span>{tr("Loss (mid band)")}</span><span>{tr("{0} dB · {1} dB/100 m", r.lossDb.toFixed(3), r.lossDbPer100m.toFixed(2))}</span>
        </div>
      );
    } else if (mode === "filter") {
      const r = filterAnalysis(data);
      extra = r && (
        <div className="kv">
          <span>{tr("Type")}</span><span>{tr(r.type)}</span>
          <span>{tr("Peak")}</span><span>{tr("{0} · IL {1} dB", fmtHz(r.peakF), r.insertionLoss.toFixed(2))}</span>
          {r.center && <><span>{tr("Centre (−3 dB)")}</span><span>{fmtHz(r.center)}</span></>}
          {r.low3 && <><span>{tr("Lower −3 dB")}</span><span>{fmtHz(r.low3)}</span></>}
          {r.high3 && <><span>{tr("Upper −3 dB")}</span><span>{fmtHz(r.high3)}</span></>}
          {r.bw3 && <><span>{tr("BW −3 dB")}</span><span>{si(r.bw3, "Hz")}</span></>}
          {r.bw6 && <><span>{tr("BW −6 dB")}</span><span>{si(r.bw6, "Hz")}</span></>}
          {r.bw60 && <><span>{tr("BW −60 dB")}</span><span>{si(r.bw60, "Hz")}</span></>}
          {r.q && <><span>Q</span><span>{r.q.toFixed(2)}</span></>}
          {r.shapeFactor && <><span>{tr("Shape factor 60/6")}</span><span>{r.shapeFactor.toFixed(2)}</span></>}
        </div>
      );
    } else if (mode === "serieslc" || mode === "shuntlc") {
      const r = lcResonator(data, mode === "serieslc" ? "series" : "shunt");
      extra = r ? (
        <div className="kv">
          <span>{tr("Resonance")}</span><span>{fmtHz(r.f0)}</span>
          <span>R</span><span>{r.r.toFixed(3)} Ω</span>
          <span>L</span><span>{si(r.l, "H")}</span>
          <span>C</span><span>{si(r.c, "F")}</span>
          <span>Q</span><span>{r.q.toFixed(1)}</span>
          <span>{tr("BW −3 dB")}</span><span>{si(r.bw, "Hz")}</span>
        </div>
      ) : <p className="hint">{tr("The −3 dB points must be inside the sweep.")}</p>;
    } else if (mode === "stats") {
      const tc = traces[activeTrace];
      if (!tc || FORMAT_BY_ID[tc.format].circular) extra = <p className="hint">{tr("Select a rectangular trace (not Smith/polar).")}</p>;
      else {
        const d = traceData({ data, memories, core }, tc);
        const v = traceValues(d, tc.channel, tc.format, { core });
        const two = markers[0].enabled && markers[1].enabled;
        const i0 = two ? nearestIndex(d, markers[0].f) : 0, i1 = two ? nearestIndex(d, markers[1].f) : d.length - 1;
        const st = traceStats(d.map((p) => p.f), v, i0, i1);
        const vt = (x: number) => valueText(tc.format, x);
        extra = st ? (
          <div className="kv">
            <span>{tr("Range")}</span><span>{two ? `M1–M2: ` : ""}{fmtHz(d[Math.min(i0, i1)].f)} – {fmtHz(d[Math.max(i0, i1)].f)}</span>
            <span>{tr("Points")}</span><span>{st.n}</span>
            <span>{tr("Minimum")}</span><span>{vt(st.min)} @ {fmtHz(st.fMin)}</span>
            <span>{tr("Maximum")}</span><span>{vt(st.max)} @ {fmtHz(st.fMax)}</span>
            <span>{tr("Mean")}</span><span>{vt(st.mean)}</span>
            <span>{tr("Std deviation")}</span><span>{vt(st.std)}</span>
            <span>{tr("Peak-to-peak")}</span><span>{vt(st.peakToPeak)}</span>
            <span>{tr("Slope")}</span><span>{Number.isNaN(st.slope) ? "—" : `${vt(st.slope * 1e6)}/MHz`}</span>
            <span>{tr("Flatness")}</span><span>{vt(st.flatness)}</span>
          </div>
        ) : <p className="hint">{tr("No finite values in the range.")}</p>;
      }
    } else if (mode === "xtal") {
      const r = crystalAnalysis(data);
      extra = r ? (
        <div className="kv">
          <span>fs</span><span>{fmtHz(r.fs, 6)}</span>
          <span>fp</span><span>{r.fp ? fmtHz(r.fp, 6) : tr("outside sweep")}</span>
          <span>Rm</span><span>{r.rm.toFixed(2)} Ω</span>
          <span>Lm</span><span>{si(r.lm, "H")}</span>
          <span>Cm</span><span>{si(r.cm, "F")}</span>
          <span>Cp</span><span>{r.cp ? si(r.cp, "F") : "—"}</span>
          <span>Q</span><span>{r.q.toFixed(0)}</span>
        </div>
      ) : <p className="hint">{tr("Sweep narrowly around the series resonance (the −3 dB points must be inside the sweep).")}</p>;
    }
    return <>{limits}{summary}{extra}</>;
  }, [data, mode, vf, mf, activeMarker, lang, traces, activeTrace, memories, core, tdrOn, markers]);

  return (
    <div className="box">
      <h3>{t("Analysis")}{mode !== "off" ? ` · ${t(MODES.find((m) => m[0] === mode)?.[1] ?? "")}` : ""}</h3>
      {content}
    </div>
  );
}
