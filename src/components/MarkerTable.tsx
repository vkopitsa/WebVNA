import { useMemo } from "react";
import { useStore, set } from "../store";
import { traceData, traceReadout, valueText } from "../display";
import { FORMAT_BY_ID, traceValues } from "../lib/formats";
import { nearestIndex } from "../lib/analysis";
import { fmtHz, si } from "../lib/units";
import { useT } from "../i18n";

export function MarkerTable() {
  const s = useStore();
  const tl = useT();
  const { data, traces, markers, activeMarker, deltaRef } = s;
  const enabledTraces = traces.map((t, i) => ({ t, i })).filter(({ t }) => t.enabled);

  // Pre-compute values of every rectangular trace once per data change.
  const values = useMemo(() => traces.map((t) => (t.enabled && !FORMAT_BY_ID[t.format].circular ? traceValues(traceData(s, t), t.channel, t.format, { core: s.core }) : null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, traces, s.memories, s.core]);

  if (!data.length) return <div className="box"><h3>{tl("Markers")}</h3><p className="hint">{tl("Sweep to see marker readouts.")}</p></div>;
  const ref = deltaRef != null && markers[deltaRef]?.enabled ? markers[deltaRef] : null;

  return (
    <div className="box">
      <h3>{tl("Markers")}{ref ? ` · ${tl("Δ relative to M{0}", deltaRef! + 1)}` : ""}</h3>
      <table className="data">
        <thead>
          <tr>
            <th>#</th><th>{tl("Frequency")}</th>
            {enabledTraces.map(({ t, i }) => <th key={i} style={{ color: t.color }}>TR{i + 1} {t.channel.toUpperCase()} {tl(FORMAT_BY_ID[t.format].label)}</th>)}
          </tr>
        </thead>
        <tbody>
          {markers.map((m, mi) => {
            if (!m.enabled) return null;
            const idx = nearestIndex(data, m.f);
            const ri = ref ? nearestIndex(data, ref.f) : -1;
            const isDelta = ref && mi !== deltaRef;
            return (
              <tr key={mi} className={mi === activeMarker ? "active" : ""} onClick={() => set({ activeMarker: mi })} style={{ cursor: "pointer" }}>
                <td>{deltaRef === mi ? tl("Δref") : `M${mi + 1}`}{m.tracking ? " ⟳" : ""}</td>
                <td>{isDelta ? `Δ ${si(data[idx].f - data[ri].f, "Hz")}` : fmtHz(data[idx].f)}</td>
                {enabledTraces.map(({ t, i }) => {
                  const v = values[i];
                  if (!v) return <td key={i}>{traceReadout(s, t, idx)}</td>;
                  if (isDelta) return <td key={i}>Δ {valueText(t.format, v[idx] - v[ri])}</td>;
                  return <td key={i}>{valueText(t.format, v[idx])}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
