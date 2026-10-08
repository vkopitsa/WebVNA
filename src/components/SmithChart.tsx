import { useRef } from "react";
import { useStore, updateMarker, set } from "../store";
import { useCanvas } from "../hooks/useCanvas";
import { cssVar, traceData, zText, SMITH_READOUTS, type SmithReadout } from "../display";
import { FORMAT_BY_ID } from "../lib/formats";
import { C, type Complex } from "../lib/complex";
import { fmtHz } from "../lib/units";
import { nearestIndex } from "../lib/analysis";
import { ChartTools } from "./ChartTools";
import { useT, tr } from "../i18n";

/** Smith chart (impedance or admittance grid) or polar chart, for traces in SMITH / POLAR format. */
export function SmithChart() {
  const s = useStore();
  const tl = useT();
  const { data, traces, memories, refs, markers, activeMarker, smithAdmittance, activeTrace, smithReadout, lang } = s;
  const circ = traces.map((t, i) => ({ t, i })).filter(({ t }) => t.enabled && FORMAT_BY_ID[t.format].circular);
  const polar = circ.length > 0 && circ.every(({ t }) => t.format === "polar");
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef(false);

  const geom = (w: number, h: number) => {
    const r = Math.max(10, Math.min(w, h) / 2 - 30);
    return { cx: w / 2, cy: h / 2 + 4, r };
  };

  const canvas = useCanvas((ctx, w, h) => {
    const { cx, cy, r } = geom(w, h);
    const P = (g: Complex): [number, number] => [cx + g[0] * r, cy - g[1] * r];
    const fg = cssVar("--chart-fg"), grid = cssVar("--grid-strong"), gridL = cssVar("--grid");
    ctx.clearRect(0, 0, w, h);
    ctx.font = "10px system-ui, sans-serif";
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.clip();
    ctx.lineWidth = 1;
    if (polar) {
      ctx.strokeStyle = gridL;
      for (const k of [0.2, 0.4, 0.6, 0.8]) { ctx.beginPath(); ctx.arc(cx, cy, k * r, 0, 2 * Math.PI); ctx.stroke(); }
      for (let a = 0; a < 180; a += 30) {
        const t = (a * Math.PI) / 180;
        ctx.beginPath(); ctx.moveTo(cx - Math.cos(t) * r, cy + Math.sin(t) * r); ctx.lineTo(cx + Math.cos(t) * r, cy - Math.sin(t) * r); ctx.stroke();
      }
    } else {
      const sign = smithAdmittance ? -1 : 1;
      const drawGrid = (sg: number, color: string) => {
        ctx.strokeStyle = color;
        for (const rn of [0.2, 0.5, 1, 2, 5]) { // constant-R circles: centre rn/(1+rn), radius 1/(1+rn)
          ctx.beginPath(); ctx.arc(cx + sg * (rn / (1 + rn)) * r, cy, r / (1 + rn), 0, 2 * Math.PI); ctx.stroke();
        }
        for (const xn of [0.2, 0.5, 1, 2, 5]) for (const sx of [1, -1]) { // constant-X arcs: centre (1, 1/x), radius 1/x
          ctx.beginPath(); ctx.arc(cx + sg * r, cy - (sx * r) / xn, r / xn, 0, 2 * Math.PI); ctx.stroke();
        }
      };
      drawGrid(sign, grid);
      if (smithAdmittance) drawGrid(1, gridL);
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
      // VSWR 2 circle
      ctx.strokeStyle = cssVar("--ref-line"); ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(cx, cy, r / 3, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.strokeStyle = grid; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
    // labels
    ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    if (polar) { for (const k of [0.2, 0.4, 0.6, 0.8, 1]) ctx.fillText(String(k), cx + k * r - 8, cy - 2); }
    else {
      for (const rn of [0, 0.2, 0.5, 1, 2, 5]) { const g = (rn - 1) / (rn + 1); ctx.fillText(String(Math.round(rn * 50)), cx + (smithAdmittance ? -g : g) * r, cy - 2); }
      ctx.textBaseline = "middle";
      for (const xn of [0.2, 0.5, 1, 2, 5]) {
        // Point where the x arc meets the outer circle: Γ = (jx − 1)/(jx + 1); −jx is its conjugate.
        const gg = C.div([-1, xn], [1, xn]);
        for (const [g, sgn] of [[gg, "+"], [C.conj(gg), "−"]] as [Complex, string][]) {
          const gp: Complex = smithAdmittance ? C.neg(g) : g;
          const [px, py] = P(C.scale(gp, 1.08));
          ctx.fillText(`${smithAdmittance ? (sgn === "+" ? "−" : "+") : sgn}j${xn * 50}`, px, py);
        }
      }
    }
    if (!circ.length) {
      ctx.textBaseline = "middle"; ctx.fillText(tr("Set a trace to SMITH or POLAR format."), cx, cy + r / 2);
      return;
    }
    // traces + overlays
    const drawPath = (pts: Complex[], color: string, dashed: boolean) => {
      ctx.strokeStyle = color; ctx.lineWidth = dashed ? 1 : 1.6; ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      const step = Math.max(1, Math.floor(pts.length / 4000));
      pts.forEach((g, i) => { if (i % step) return; const [x, y] = P(g); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    };
    for (const { t, i } of circ) {
      const d = traceData(s, t);
      if (t.memory && t.math === "off" && memories[t.memory]) drawPath(memories[t.memory]!.map((p) => p[t.channel]), t.color, true);
      if (i === activeTrace) for (const ref of refs) if (ref.visible && (t.channel === "s11" || ref.ports === 2)) drawPath(ref.data.map((p) => p[t.channel]), ref.color, true);
      if (d.length) drawPath(d.map((p) => p[t.channel]), t.color, false);
    }
    // markers
    const lines: { text: string; color: string }[] = [];
    markers.forEach((m, mi) => {
      if (!m.enabled || !data.length) return;
      for (const { t } of circ) {
        const d = traceData(s, t);
        if (!d.length) continue;
        const idx = nearestIndex(d, m.f);
        const [x, y] = P(d[idx][t.channel]);
        const act = mi === activeMarker;
        ctx.fillStyle = act ? t.color : cssVar("--chart-bg"); ctx.strokeStyle = t.color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, y, act ? 5 : 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        ctx.fillStyle = t.color; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.font = "bold 10px system-ui";
        ctx.fillText(String(mi + 1), x + 6, y - 3);
        ctx.font = "10px system-ui, sans-serif";
        if (act) {
          const p = d[idx];
          lines.push({ text: `M${mi + 1} ${fmtHz(p.f)}`, color: cssVar("--fg") });
          lines.push({ text: zText(p, t.channel, t.format === "polar" ? "lin" : smithReadout), color: t.color });
        }
      }
    });
    ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    lines.forEach((l, i) => { ctx.fillStyle = l.color; ctx.fillText(l.text, 8, 8 + i * 15); });
  }, [data, traces, memories, refs, markers, activeMarker, smithAdmittance, activeTrace, polar, smithReadout, lang]);

  const pick = (e: React.PointerEvent) => {
    const c = canvas.current!;
    const rc = c.getBoundingClientRect();
    const { cx, cy, r } = geom(rc.width, rc.height);
    const g: Complex = [(e.clientX - rc.left - cx) / r, -(e.clientY - rc.top - cy) / r];
    const t = circ.find((x) => x.i === activeTrace)?.t ?? circ[0]?.t;
    if (!t || !data.length) return;
    const d = traceData(s, t);
    let best = 0, bd = Infinity;
    for (let i = 0; i < d.length; i++) { const dd = C.abs2(C.sub(d[i][t.channel], g)); if (dd < bd) { bd = dd; best = i; } }
    updateMarker(activeMarker, { f: d[best].f, enabled: true, tracking: null });
  };

  return (
    <div className="chart" ref={wrap}>
      <ChartTools target={wrap} canvas={canvas} name={polar ? "polar" : "smith"} />
      {!polar && (
        <div style={{ position: "absolute", left: 8, bottom: 6, zIndex: 2 }}>
          <button className={"small" + (smithAdmittance ? " on" : "")} onClick={() => set({ smithAdmittance: !smithAdmittance })} title={tl("Show admittance grid")}>{tl("Y grid")}</button>{" "}
          <select aria-label={tl("Smith marker readout")} value={smithReadout} onChange={(e) => set({ smithReadout: e.target.value as SmithReadout })} style={{ fontSize: 12, padding: "1px 4px" }}>
            {SMITH_READOUTS.map(([v, l]) => <option key={v} value={v}>{tl(l)}</option>)}
          </select>
        </div>
      )}
      <canvas ref={canvas}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = true; pick(e); }}
        onPointerMove={(e) => { if (drag.current) pick(e); }}
        onPointerUp={() => { drag.current = false; }}
        onPointerCancel={() => { drag.current = false; }}
        aria-label={tl("Smith chart. Click or drag to move the active marker.")} />
    </div>
  );
}
