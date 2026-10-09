import { useMemo, useRef, useState } from "react";
import { useStore, set, updateMarker, updateTrace } from "../store";
import { rectSeries, cssVar, valueText, limitReports, type Series } from "../display";
import { useCanvas } from "../hooks/useCanvas";
import { fmtHz, fmtHzShort, si } from "../lib/units";
import { FORMAT_BY_ID } from "../lib/formats";
import { SPEED_OF_LIGHT } from "../lib/units";
import { limitsOf } from "../caps";
import { restartIfRunning } from "../controller";
import { ChartTools } from "./ChartTools";
import { ScaleTools } from "./ScaleTools";
import { useT, tr } from "../i18n";

const DIV_Y = 8, DIV_X = 10;
const M = { l: 62, r: 58, t: 40, b: 56 };
const MIN_SPAN_HZ = 1e3;
const DOUBLE_TAP_MS = 300, TAP_SLOP_PX = 10;

interface Touch { x: number; y: number; x0: number; y0: number; t0: number }
/** State captured when the second finger lands. `d0` is the finger distance along the pinch axis. */
interface Pinch {
  axis: "x" | "y"; d0: number;
  /** x axis: plot-domain value (log for log sweeps) under the pinch centre, and the view span. */
  c0: number; span0: number;
  /** y axis: trace being scaled and its scale at the start. */
  ti: number; perDiv0: number; ref: number; refPos: number;
}

export function RectChart() {
  const s = useStore();
  const tl = useT();
  const { data, traces, activeTrace, memories, refs, tdr, gate, core, markers, activeMarker, deltaRef, sweepMode, lang } = s;
  const { series, xKind } = useMemo(() => rectSeries(s),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, traces, activeTrace, memories, refs, tdr, core, lang]);
  const reports = useMemo(() => (tdr.enabled ? [] : limitReports({ data, memories, core, traces })), [data, memories, core, traces, tdr.enabled]);
  const [hover, setHover] = useState<number | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const drag = useRef<"marker" | "zoom" | "pinch" | null>(null);
  const touches = useRef(new Map<number, Touch>());
  const pinch = useRef<Pinch | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const xr = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const se of series) if (se.x.length) { lo = Math.min(lo, se.x[0]); hi = Math.max(hi, se.x[se.x.length - 1]); }
    if (!isFinite(lo)) { lo = s.start; hi = s.stop; }
    if (hi <= lo) hi = lo + 1;
    return { lo, hi, log: xKind === "freq" && sweepMode === "log" && lo > 0 };
  }, [series, xKind, sweepMode, s.start, s.stop]);

  const geom = (w: number, h: number) => {
    const pw = w - M.l - M.r, ph = h - M.t - M.b;
    const xToPx = (x: number) => M.l + (xr.log ? Math.log(x / xr.lo) / Math.log(xr.hi / xr.lo) : (x - xr.lo) / (xr.hi - xr.lo)) * pw;
    const pxToX = (px: number) => { const t = Math.min(1, Math.max(0, (px - M.l) / pw)); return xr.log ? xr.lo * Math.pow(xr.hi / xr.lo, t) : xr.lo + t * (xr.hi - xr.lo); };
    return { pw, ph, xToPx, pxToX };
  };
  /** The x axis in its linear domain (log of frequency on log sweeps), so pinch maths is the same for both. */
  const toU = (x: number) => (xr.log ? Math.log(x) : x);
  const fromU = (u: number) => (xr.log ? Math.exp(u) : u);

  const xLabel = (x: number) => (xKind === "freq" ? fmtHzShort(x) : xKind === "distance" ? `${x.toFixed(x < 10 ? 2 : 1)} m` : si(x, "s", 3));

  const canvas = useCanvas((ctx, w, h) => {
    const { pw, ph, xToPx } = geom(w, h);
    const fg = cssVar("--chart-fg"), grid = cssVar("--grid"), gridStrong = cssVar("--grid-strong");
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px system-ui, sans-serif";
    // grid
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let i = 0; i <= DIV_Y; i++) { const y = Math.round(M.t + (ph * i) / DIV_Y) + 0.5; ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l + pw, y); ctx.stroke(); }
    const xt: number[] = [];
    if (xr.log) { for (let e = Math.floor(Math.log10(xr.lo)); e <= Math.ceil(Math.log10(xr.hi)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= xr.lo && v <= xr.hi) xt.push(v); } }
    else for (let i = 0; i <= DIV_X; i++) xt.push(xr.lo + ((xr.hi - xr.lo) * i) / DIV_X);
    ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "top";
    xt.forEach((v, i) => {
      const x = Math.round(xToPx(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, M.t + ph); ctx.stroke();
      if (xr.log || i % 2 === 0 || pw > 700) ctx.fillText(xLabel(v), x, M.t + ph + 6);
    });
    ctx.strokeStyle = gridStrong; ctx.strokeRect(M.l + 0.5, M.t + 0.5, pw, ph);

    if (!series.length) {
      ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(data.length ? tr("No rectangular traces enabled.") : tr("Connect and press Sweep (or use the simulator)."), M.l + pw / 2, M.t + ph / 2);
      return;
    }
    const yToPx = (se: Series, v: number) => M.t + ph - ((v - se.scale.ref) / se.scale.perDiv + se.scale.refPos) * (ph / DIV_Y);
    // y labels of the active trace (or first)
    const lab = series.find((se) => se.traceIndex === activeTrace && se.primary) ?? series[0];
    ctx.fillStyle = lab.color; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= DIV_Y; i++) {
      const v = lab.scale.ref + (i - lab.scale.refPos) * lab.scale.perDiv;
      const txt = lab.unit === "dB" || lab.unit === "°" ? `${+v.toFixed(3)}` : lab.unit ? si(v, lab.unit, 3) : `${+v.toPrecision(4)}`;
      ctx.fillText(txt, M.l - 5, M.t + ph - (ph * i) / DIV_Y);
    }
    // right axis: the first other primary trace with a different scale
    const lab2 = series.find((se) => se.primary && se !== lab && (se.unit !== lab.unit || se.scale.perDiv !== lab.scale.perDiv || se.scale.ref !== lab.scale.ref));
    if (lab2) {
      ctx.fillStyle = lab2.color; ctx.textAlign = "left";
      for (let i = 0; i <= DIV_Y; i++) {
        const v = lab2.scale.ref + (i - lab2.scale.refPos) * lab2.scale.perDiv;
        const txt = lab2.unit === "dB" || lab2.unit === "°" ? `${+v.toFixed(3)}` : lab2.unit ? si(v, lab2.unit, 3) : `${+v.toPrecision(4)}`;
        ctx.fillText(txt, M.l + pw + 5, M.t + ph - (ph * i) / DIV_Y);
      }
      ctx.textAlign = "right";
    }
    // reference marker ▶ at refPos
    ctx.fillStyle = lab.color;
    const ry = M.t + ph - lab.scale.refPos * (ph / DIV_Y);
    ctx.beginPath(); ctx.moveTo(M.l - 1, ry - 4); ctx.lineTo(M.l + 5, ry); ctx.lineTo(M.l - 1, ry + 4); ctx.fill();
    // VSWR 2 line on SWR traces
    for (const se of series) if (se.primary && traces[se.traceIndex].format === "swr" && !tdr.enabled) {
      const y = yToPx(se, 2);
      if (y > M.t && y < M.t + ph) { ctx.strokeStyle = cssVar("--ref-line"); ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l + pw, y); ctx.stroke(); ctx.setLineDash([]); }
    }
    // traces
    ctx.save();
    ctx.beginPath(); ctx.rect(M.l, M.t, pw, ph); ctx.clip();
    for (const se of series) {
      ctx.strokeStyle = se.color; ctx.lineWidth = se.primary ? 1.6 : 1.1;
      ctx.setLineDash(se.dashed ? [4, 3] : []);
      ctx.globalAlpha = se.primary ? 1 : 0.75;
      ctx.beginPath();
      let started = false;
      const step = Math.max(1, Math.floor(se.x.length / (pw * 2)));
      for (let i = 0; i < se.x.length; i += step) {
        const v = se.y[i];
        if (Number.isNaN(v)) { started = false; continue; } // ±Infinity (e.g. SWR at |Γ| ≥ 1) is clipped at the edge
        const x = xToPx(se.x[i]), y = Math.max(-1e4, Math.min(1e4, yToPx(se, v)));
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // limit lines (thick dashed, trace colour) with failing points in red
    ctx.lineCap = "butt";
    for (const r of reports) {
      const t = traces[r.index], se = series.find((x) => x.traceIndex === r.index && x.primary);
      if (!se) continue;
      ctx.strokeStyle = t.color; ctx.lineWidth = 3.5; ctx.globalAlpha = 0.7; ctx.setLineDash([9, 5]);
      for (const l of t.limits) {
        if (l.enabled === false) continue;
        ctx.beginPath();
        if (xr.log && (l.f1 <= 0 || l.f2 <= 0)) continue;
        ctx.moveTo(xToPx(l.f1), Math.max(-1e4, Math.min(1e4, yToPx(se, l.v1)))); ctx.lineTo(xToPx(l.f2), Math.max(-1e4, Math.min(1e4, yToPx(se, l.v2))));
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = cssVar("--err");
      for (const i of r.result.failIndex) {
        const v = se.y[i];
        if (!Number.isNaN(v)) { ctx.beginPath(); ctx.arc(xToPx(se.x[i]), Math.max(-1e4, Math.min(1e4, yToPx(se, v))), 3, 0, 2 * Math.PI); ctx.fill(); }
      }
    }
    // gate (time-domain view)
    if (tdr.enabled && gate.enabled && xKind !== "freq") {
      const k = xKind === "time" ? 1 : (SPEED_OF_LIGHT * tdr.velocityFactor) / (gate.channel === "s21" ? 1 : 2);
      const a = xToPx((gate.center - gate.span / 2) * k), b = xToPx((gate.center + gate.span / 2) * k);
      ctx.fillStyle = cssVar(gate.type === "notch" ? "--err" : "--accent"); ctx.globalAlpha = 0.15;
      ctx.fillRect(a, M.t, b - a, ph); ctx.globalAlpha = 0.8; ctx.setLineDash([5, 3]); ctx.strokeStyle = ctx.fillStyle;
      ctx.beginPath(); ctx.moveTo(a, M.t); ctx.lineTo(a, M.t + ph); ctx.moveTo(b, M.t); ctx.lineTo(b, M.t + ph); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // PASS/FAIL badges (bottom right of the plot)
    ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.font = "bold 11px system-ui, sans-serif";
    reports.forEach((r, k) => {
      const tw = ctx.measureText(r.text).width + 12, bx = M.l + pw - 6 - tw, by = M.t + ph - 8 - 18 * (reports.length - k);
      const col = cssVar(r.status === "pass" ? "--ok" : r.status === "fail" ? "--err" : "--warn");
      ctx.fillStyle = cssVar("--chart-bg"); ctx.globalAlpha = 0.85; ctx.fillRect(bx, by, tw, 16); ctx.globalAlpha = 1;
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, 15);
      ctx.fillStyle = col; ctx.fillText(r.text, bx + tw - 6, by + 8.5);
    });
    ctx.font = "11px system-ui, sans-serif";
    // legend
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let lx = M.l, ly = 10;
    for (const se of series) {
      const num = (v: number) => (se.unit === "dB" || se.unit === "°" ? `${+v.toFixed(3)}${se.unit}` : se.unit ? si(v, se.unit, 3) : `${+v.toPrecision(4)}`);
      const txt = tdr.enabled ? se.label : `${se.label}  ${num(se.scale.perDiv)}/  ${tr("ref {0}", num(se.scale.ref))}`;
      const tw = ctx.measureText(txt).width + 28;
      if (lx + tw > w - 80 && lx > M.l) { lx = M.l; ly += 14; }
      if (ly > 24) break;
      ctx.fillStyle = se.color;
      ctx.fillRect(lx, ly, 10, 3);
      ctx.fillText(txt, lx + 14, ly + 2);
      lx += tw;
    }
    // markers (frequency domain only)
    if (!tdr.enabled) {
      markers.forEach((m, mi) => {
        if (!m.enabled || m.f < xr.lo || m.f > xr.hi) return;
        const x = xToPx(m.f);
        for (const se of series) {
          if (!se.primary) continue;
          let lo = 0, hi = se.x.length - 1;
          while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (se.x[mid] <= m.f) lo = mid; else hi = mid; }
          const i = Math.abs(se.x[lo] - m.f) <= Math.abs(se.x[hi] - m.f) ? lo : hi;
          const y = Math.max(M.t + 10, Math.min(M.t + ph, yToPx(se, se.y[i])));
          const act = mi === activeMarker;
          ctx.fillStyle = act ? se.color : cssVar("--chart-bg");
          ctx.strokeStyle = se.color; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 6, y - 10); ctx.lineTo(x + 6, y - 10); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillStyle = act ? cssVar("--chart-bg") : se.color; ctx.textAlign = "center"; ctx.font = "bold 9px system-ui";
          ctx.fillText(deltaRef === mi ? "Δ" : String(mi + 1), x, y - 6.5);
          ctx.font = "11px system-ui, sans-serif";
        }
      });
    }
    // hover crosshair + readout
    if (hover != null && hover >= xr.lo && hover <= xr.hi) {
      const x = xToPx(hover);
      ctx.strokeStyle = fg; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, M.t + ph); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const lines = [xKind === "freq" ? fmtHz(hover) : xLabel(hover)];
      const cols = ["--fg"];
      for (const se of series) {
        if (!se.primary) continue;
        let lo = 0, hi = se.x.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (se.x[mid] <= hover) lo = mid; else hi = mid; }
        const v = se.y[Math.abs(se.x[lo] - hover) <= Math.abs(se.x[hi] - hover) ? lo : hi];
        const t = traces[se.traceIndex];
        lines.push(tdr.enabled ? `${se.unit ? si(v, se.unit) : v.toFixed(4)}` : `${t.channel.toUpperCase()} ${tr(FORMAT_BY_ID[t.format].label)}: ${valueText(t.format, v)}`);
        cols.push(se.color);
      }
      const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14, bh = lines.length * 15 + 8;
      const bx = x + bw + 12 > w ? x - bw - 8 : x + 8, by = M.t + 6;
      ctx.fillStyle = cssVar("--panel"); ctx.globalAlpha = 0.92; ctx.fillRect(bx, by, bw, bh); ctx.globalAlpha = 1;
      ctx.strokeStyle = gridStrong; ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      lines.forEach((l, i) => { ctx.fillStyle = i === 0 ? cssVar("--fg") : cols[i]; ctx.fillText(l, bx + 7, by + 5 + i * 15); });
    }
    // zoom box
    if (zoom) {
      const a = xToPx(zoom[0]), b = xToPx(zoom[1]);
      ctx.fillStyle = cssVar("--accent"); ctx.globalAlpha = 0.15;
      const x0 = Math.max(M.l, Math.min(a, b)), x1 = Math.min(M.l + pw, Math.max(a, b)); // zooming out can exceed the plot
      ctx.fillRect(x0, M.t, Math.max(0, x1 - x0), ph); ctx.globalAlpha = 1;
      if (xKind === "freq") {
        ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(`${fmtHzShort(Math.min(...zoom))} … ${fmtHzShort(Math.max(...zoom))}`, M.l + pw / 2, M.t + 4);
      }
    }
  }, [series, markers, activeMarker, deltaRef, hover, zoom, xr, activeTrace, tdr.enabled, tdr.velocityFactor, gate, reports, lang]);

  const xAt = (e: React.PointerEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return geom(r.width, r.height).pxToX(e.clientX - r.left);
  };
  const autoScale = () => set((st) => ({ traces: st.traces.map((t) => ({ ...t, scale: { ...t.scale, auto: true } })) }));

  /** Starts a pinch from the two tracked fingers; the axis follows the line between them. */
  const startPinch = (r: DOMRect) => {
    const [a, b] = [...touches.current.values()];
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    const { pxToX } = geom(r.width, r.height);
    const lab = series.find((se) => se.traceIndex === activeTrace && se.primary) ?? series.find((se) => se.primary);
    const axis = dx >= dy ? "x" : "y";
    if (axis === "x" ? xKind !== "freq" : !lab || tdr.enabled) return false; // nothing to pinch here
    pinch.current = {
      axis, d0: Math.max(axis === "x" ? dx : dy, 20),
      c0: toU(pxToX((a.x + b.x) / 2 - r.left)), span0: toU(xr.hi) - toU(xr.lo),
      ti: lab?.traceIndex ?? 0, perDiv0: lab?.scale.perDiv ?? 1, ref: lab?.scale.ref ?? 0, refPos: lab?.scale.refPos ?? 0,
    };
    return true;
  };
  /** Horizontal pinch → new frequency range (preview only); vertical pinch → trace scale/div, applied live. */
  const movePinch = (r: DOMRect) => {
    const p = pinch.current;
    if (!p || touches.current.size < 2) return;
    const [a, b] = [...touches.current.values()];
    if (p.axis === "y") {
      const ratio = Math.abs(a.y - b.y) / p.d0; // fingers apart = fewer units per division
      const perDiv = +(p.perDiv0 / Math.max(0.05, Math.min(20, ratio))).toPrecision(3);
      if (perDiv > 0 && isFinite(perDiv)) updateTrace(p.ti, { scale: { auto: false, perDiv, ref: p.ref, refPos: p.refPos } });
      return;
    }
    const ratio = Math.max(0.05, Math.min(20, Math.abs(a.x - b.x) / p.d0));
    const { pw } = geom(r.width, r.height);
    const f = Math.min(1, Math.max(0, ((a.x + b.x) / 2 - r.left - M.l) / pw)); // the centre may drift: pinch also pans
    const span = p.span0 / ratio;
    const lo = p.c0 - f * span;
    setZoom([fromU(lo), fromU(lo + span)]);
  };
  const endPinch = () => {
    const p = pinch.current;
    pinch.current = null;
    if (!p || p.axis !== "x" || !zoom) return;
    const { minHz: MIN_HZ, maxHz: max } = limitsOf(useStore.getState().capabilities);
    let [lo, hi] = [Math.min(...zoom), Math.max(...zoom)];
    if (hi - lo < MIN_SPAN_HZ) { const c = (lo + hi) / 2; lo = c - MIN_SPAN_HZ / 2; hi = c + MIN_SPAN_HZ / 2; }
    if (lo < MIN_HZ) { hi += MIN_HZ - lo; lo = MIN_HZ; }
    if (hi > max) { lo = Math.max(MIN_HZ, lo - (hi - max)); hi = max; }
    lo = Math.round(lo); hi = Math.round(hi);
    if (hi <= lo || Math.abs(Math.log((hi - lo) / (xr.hi - xr.lo))) < 0.03) return; // a twitch, not a zoom
    set({ start: lo, stop: hi }); restartIfRunning();
  };

  const moveMarker = (x: number) => {
    if (xKind !== "freq") return;
    updateMarker(activeMarker, { f: x, enabled: true, tracking: null });
  };

  return (
    <div className="chart" ref={wrap}>
      <ChartTools target={wrap} canvas={canvas} name="rect" />
      {!tdr.enabled && <ScaleTools series={series} target={wrap} />}
      <canvas ref={canvas}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          if (e.pointerType === "touch") {
            touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
            if (touches.current.size === 2) { // second finger: stop moving the marker, start a pinch
              drag.current = null; setHover(null); setZoom(null);
              if (startPinch(canvas.current!.getBoundingClientRect())) drag.current = "pinch";
              return;
            }
            if (touches.current.size > 2) return;
          }
          const x = xAt(e);
          if (e.shiftKey && xKind === "freq") { drag.current = "zoom"; setZoom([x, x]); }
          else { drag.current = "marker"; moveMarker(x); }
        }}
        onPointerMove={(e) => {
          const tp = touches.current.get(e.pointerId);
          if (tp) { tp.x = e.clientX; tp.y = e.clientY; }
          if (drag.current === "pinch") { movePinch(canvas.current!.getBoundingClientRect()); return; }
          if (touches.current.size > 1) return;
          const x = xAt(e);
          setHover(x);
          if (drag.current === "marker") moveMarker(x);
          else if (drag.current === "zoom") setZoom((z) => (z ? [z[0], x] : null));
        }}
        onPointerUp={(e) => {
          const tp = touches.current.get(e.pointerId);
          touches.current.delete(e.pointerId);
          if (drag.current === "pinch") {
            if (touches.current.size < 2) { endPinch(); drag.current = null; setZoom(null); }
            return;
          }
          if (tp && !touches.current.size && Math.hypot(e.clientX - tp.x0, e.clientY - tp.y0) < TAP_SLOP_PX && e.timeStamp - tp.t0 < 400) {
            const lt = lastTap.current;
            if (lt && e.timeStamp - lt.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) { autoScale(); lastTap.current = null; }
            else lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
          }
          if (drag.current === "zoom" && zoom) {
            const [a, b] = [Math.min(...zoom), Math.max(...zoom)];
            if (b - a > (xr.hi - xr.lo) / 200) { set({ start: Math.round(a), stop: Math.round(b) }); restartIfRunning(); }
          }
          drag.current = null; setZoom(null);
        }}
        onPointerLeave={() => { if (!drag.current) setHover(null); }}
        onPointerCancel={() => { touches.current.clear(); pinch.current = null; drag.current = null; setZoom(null); setHover(null); }}
        onDoubleClick={autoScale}
        aria-label={tl("Rectangular chart. Drag to move the active marker, Shift-drag to zoom, double-click to auto-scale. Touch: drag to move the marker, pinch to zoom, double-tap to auto-scale.")}
      />
    </div>
  );
}
