import { useEffect, useState } from "react";
import { useStore, log } from "./store";
import { Toolbar } from "./components/Toolbar";
import { StimulusPanel } from "./components/StimulusPanel";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { DisplayPanel } from "./components/DisplayPanel";
import { MarkersPanel } from "./components/MarkersPanel";
import { MeasurePanel, AnalysisBox } from "./components/MeasurePanel";
import { DevicePanel } from "./components/DevicePanel";
import { FilesPanel } from "./components/FilesPanel";
import { ScriptPanel } from "./components/ScriptPanel";
import { RectChart } from "./components/RectChart";
import { SmithChart } from "./components/SmithChart";
import { MarkerTable } from "./components/MarkerTable";
import { LogPanel } from "./components/LogPanel";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { useT, tr } from "./i18n";
import { loadSharedFromHash } from "./session";
import { disconnect, hasWebSerial, reconnectKnown, restoreActiveCal, updateMarkers } from "./controller";

const TABS = [
  ["stimulus", "Stimulus", StimulusPanel],
  ["cal", "Calibrate", CalibrationPanel],
  ["display", "Display", DisplayPanel],
  ["markers", "Markers", MarkersPanel],
  ["measure", "Measure", MeasurePanel],
  ["device", "Device", DevicePanel],
  ["files", "Files", FilesPanel],
  ["script", "Script", ScriptPanel],
] as const;

let booted = false;

export default function App() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("stimulus");
  const [drawer, setDrawer] = useState(false); // settings drawer on narrow screens
  const showRect = useStore((s) => s.showRect);
  const showSmith = useStore((s) => s.showSmith);
  const markers = useStore((s) => s.markers);
  const lang = useStore((s) => s.lang);
  const t = useT();
  const Panel = TABS.find((x) => x[0] === tab)![2];

  useEffect(() => {
    if (booted) return;
    booted = true;
    restoreActiveCal();
    if (!hasWebSerial()) log(tr("Web Serial isn't available here. Use Chrome or Edge on desktop (https or localhost). The simulator still works."), "error");
    else if (!location.hash.startsWith("#s=")) void reconnectKnown();
    void loadSharedFromHash();
    const bye = () => { void disconnect(); };
    window.addEventListener("beforeunload", bye);
  }, []);

  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  // Tracking markers follow tracking mode changes immediately.
  useEffect(() => { updateMarkers(); }, [markers]);

  return (
    <div className="app">
      <Toolbar onMenu={() => setDrawer((d) => !d)} menuOpen={drawer} />
      <div className="body">
        {drawer && <div className="backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />}
        <aside className={"side" + (drawer ? " open" : "")} aria-label={t("Settings")}>
          <nav className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{t(label)}</button>
            ))}
            <button className="mobile-only drawer-close" onClick={() => setDrawer(false)} aria-label={t("Close settings")}>✕</button>
          </nav>
          <div className="panel"><Panel /></div>
        </aside>
        <main className="main">
          <div className={"charts" + (showRect && showSmith ? "" : " single")}>
            {showRect && <RectChart />}
            {showSmith && <SmithChart />}
          </div>
          <div className="bottom">
            <MarkerTable />
            <AnalysisBox />
          </div>
          <div className="bottom" style={{ gridTemplateColumns: "1fr" }}>
            <LogPanel />
          </div>
        </main>
      </div>
      <UpdatePrompt />
    </div>
  );
}
