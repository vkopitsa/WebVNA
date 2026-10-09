import { useMemo } from "react";
import { useStore, set } from "../store";
import { capturePattern, clearPattern, exportPatternCsv, undoPattern } from "../controller";
import { patternMetrics, patternValueAt } from "../lib/pattern";
import { fmtHz } from "../lib/units";
import { useCanvas } from "../hooks/useCanvas";
import { cssVar } from "../display";
import { FreqInput, Num, Section } from "./inputs";
import { useT, tr } from "../i18n";

const RANGE = 30; // dB shown from the peak to the centre

function PatternChart() {
  const pattern = useStore((s) => s.pattern);
  const lang = useStore((s) => s.lang);
  const ref = useCanvas((ctx, w, h) => {
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 18;
    ctx.fillStyle = cssVar("--chart-bg"); ctx.fillRect(0, 0, w, h);
    ctx.font = "11px system-ui, sans-serif";
    ctx.strokeStyle = cssVar("--grid-strong"); ctx.fillStyle = cssVar("--chart-fg"); ctx.lineWidth = 1;
    for (let k = 0; k <= RANGE; k += 10) {
      const rr = r * (1 - k / RANGE);
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(rr, 0.5), 0, 2 * Math.PI); ctx.stroke();
      if (k < RANGE) ctx.fillText(`−${k}`, cx + 3, cy - rr + 11);
    }
    for (let a = 0; a < 360; a += 30) {
      const t = ((a - 90) * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + r * Math.cos(t), cy + r * Math.sin(t)); ctx.stroke();
      ctx.textAlign = "center"; ctx.fillText(`${a}°`, cx + (r + 10) * Math.cos(t), cy + (r + 10) * Math.sin(t) + 4);
    }
    ctx.textAlign = "start";
    const pts = pattern.points;
    if (!pts.length) { ctx.fillText(tr("No points captured."), 8, 14); return; }
    const peak = Math.max(...pts.map((p) => p.db));
    const xy = (deg: number, db: number): [number, number] => {
      const rr = r * Math.max(0, 1 + (db - peak) / RANGE), t = ((deg - 90) * Math.PI) / 180;
      return [cx + rr * Math.cos(t), cy + rr * Math.sin(t)];
    };
    ctx.strokeStyle = cssVar("--accent"); ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 2;
    ctx.beginPath();
    let pen = false;
    for (let deg = 0; deg <= 360; deg += 1) {
      const db = pts.length > 1 ? patternValueAt(pts, deg) : NaN;
      if (!Number.isFinite(db)) { pen = false; continue; }
      const [x, y] = xy(deg, db);
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    for (const p of pts) { const [x, y] = xy(p.deg, p.db); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill(); }
    // next capture angle
    const [nx, ny] = xy(pattern.angle, peak);
    ctx.strokeStyle = cssVar("--ref-line"); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny); ctx.stroke(); ctx.setLineDash([]);
  }, [pattern, lang]);
  return <canvas ref={ref} style={{ width: "100%", aspectRatio: "1", display: "block" }} aria-label={tr("Radiation pattern")} />;
}

export function PatternSection() {
  const t = useT();
  const p = useStore((s) => s.pattern);
  const busy = useStore((s) => s.patternBusy || (s.running && !s.continuous));
  const connected = useStore((s) => s.status === "connected");
  const markerF = useStore((s) => s.markers[s.activeMarker]?.f ?? 0);
  const m = useMemo(() => patternMetrics(p.points), [p.points]);
  const patch = (q: Partial<typeof p>) => set((s) => ({ pattern: { ...s.pattern, ...q } }));
  return (
    <Section title="Radiation pattern">
      <p className="hint">{t("Antenna under test on port 2, a fixed source antenna on port 1. Rotate the antenna by the step, press Capture, repeat. Each capture takes a fresh sweep.")}</p>
      <div className="row">
        <label>{t("Frequency")}</label>
        {p.freq == null
          ? <button className="small" onClick={() => patch({ freq: markerF || null })}>{t("Active marker ({0})", fmtHz(markerF))}</button>
          : <><FreqInput value={p.freq} onChange={(v) => patch({ freq: v })} ariaLabel="Pattern frequency" /><button className="small" onClick={() => patch({ freq: null })}>{t("Use marker")}</button></>}
      </div>
      <div className="row">
        <label>{t("Step (°)")}</label><Num value={p.step} min={1} max={180} step={1} onChange={(v) => patch({ step: v })} ariaLabel="Angle step" />
        <label>{t("Next angle (°)")}</label><Num value={p.angle} min={0} max={359} step={1} onChange={(v) => patch({ angle: ((v % 360) + 360) % 360 })} ariaLabel="Next angle" />
      </div>
      <div className="row">
        <button className="primary" disabled={busy || !connected} onClick={() => void capturePattern()}>{t("Capture {0}°", p.angle)}</button>
        <button disabled={!p.history.length} onClick={() => undoPattern()}>{t("Undo")}</button>
        <button disabled={!p.points.length} onClick={() => exportPatternCsv()}>{t("Export CSV")}</button>
        <button className="danger" disabled={!p.points.length} onClick={() => clearPattern()}>{t("Clear")}</button>
      </div>
      <PatternChart />
      {m && (
        <div className="kv">
          <span>{t("Peak")}</span><span>{`${m.peakDb.toFixed(2)} dB @ ${m.peakDeg}°`}</span>
          <span>{t("Beamwidth −3 dB")}</span><span>{m.beamwidth != null ? `${m.beamwidth.toFixed(1)}°` : "—"}</span>
          <span>{t("Front-to-back")}</span><span>{m.frontToBack != null ? `${m.frontToBack.toFixed(1)} dB` : "—"}</span>
          <span>{t("Points")}</span><span>{p.points.length}</span>
        </div>
      )}
    </Section>
  );
}
