import { useStore } from "../store";
import { connectBluetooth, connectSerial, connectSimulator, connectUsb, disconnect, hasWebSerial, hasWebUsb, startContinuous, stop, sweepOnce } from "../controller";
import { calCovers } from "../lib/calibration";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { LangSelect } from "./inputs";

export function Toolbar({ onMenu, menuOpen }: { onMenu: () => void; menuOpen: boolean }) {
  const status = useStore((s) => s.status);
  const info = useStore((s) => s.info);
  const linkKind = useStore((s) => s.linkKind);
  const running = useStore((s) => s.running);
  const continuous = useStore((s) => s.continuous);
  const progress = useStore((s) => s.progress);
  const cal = useStore((s) => s.cal);
  const calEnabled = useStore((s) => s.calEnabled);
  const deviceCal = useStore((s) => s.deviceCal);
  const vbat = useStore((s) => s.vbat);
  const caps = useStore((s) => s.capabilities);
  const start = useStore((s) => s.start), stopHz = useStore((s) => s.stop);
  const lastSweepMs = useStore((s) => s.lastSweepMs);
  const points = useStore((s) => s.points);
  const t = useT();
  const connected = status === "connected";
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("webvna.theme") || "auto"; } catch { return "auto"; } });
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("webvna.theme", theme); } catch { /* ignore */ }
  }, [theme]);

  // Keyboard: Space = single sweep, R = run/stop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, select, textarea")) return;
      if (e.key === " " && connected) { e.preventDefault(); void sweepOnce(); }
      if ((e.key === "r" || e.key === "R") && connected) { if (continuous) stop(); else void startContinuous(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connected, continuous]);

  let calBadge = <span className="badge warn">{t("Raw")}</span>;
  if (deviceCal && caps?.deviceCal !== false) calBadge = <span className="badge ok">{t("Device cal")}</span>;
  else if (cal && calEnabled) calBadge = calCovers(cal, start, stopHz)
    ? <span className="badge ok" title={cal.name}>{t("Calibrated")}</span>
    : <span className="badge warn" title={t("The sweep extends outside the calibrated range; edge terms are extrapolated.")}>{t("Cal (out of range)")}</span>;
  else if (cal) calBadge = <span className="badge warn">{t("Cal off")}</span>;

  return (
    <div className="toolbar">
      <button className="mobile-only menu-btn" onClick={onMenu} aria-label={t("Settings")} aria-expanded={menuOpen}>☰</button>
      <span className="brand">WebVNA</span>
      {!connected ? (
        <>
          <button className="primary" disabled={status === "connecting" || !hasWebSerial()} onClick={() => connectSerial()} title={hasWebSerial() ? "" : t("Web Serial needs Chrome or Edge")}>{t("Connect")}</button>
          {hasWebSerial() && <button disabled={status === "connecting"} onClick={() => connectBluetooth()} title={t("Bluetooth serial module (Chrome on Android, experimental)")}>Bluetooth</button>}
          {hasWebUsb() && <button disabled={status === "connecting"} title={t("WebUSB: LiteVNA / NanoVNA V2 over USB serial, or LibreVNA (experimental)")} onClick={() => connectUsb()}>WebUSB</button>}
          <button disabled={status === "connecting"} onClick={() => connectSimulator()}>{t("Simulator")}</button>
        </>
      ) : (
        <button onClick={() => disconnect()}>{t("Disconnect")}</button>
      )}
      {connected && info && <span className="hint device-info">{info.model} · {caps?.protocol !== "v2" ? `${t("fw {0}", info.firmware ?? "?")} · ${t("experimental")}` : t("fw {0}.{1}", info.fwMajor, info.fwMinor)} · {t(linkKind)}{vbat != null ? ` · ${vbat.toFixed(2)} V` : ""}</span>}
      {status === "connecting" && <span className="hint">{t("Connecting…")}</span>}
      <span className="spacer" />
      {calBadge}
      <button disabled={!connected || running} onClick={() => sweepOnce()} title={t("Single sweep (Space)")}>{t("Sweep")}</button>
      {continuous
        ? <button className="on" onClick={() => stop()} title={t("Stop (R)")}>{t("Stop{0}", "")}</button>
        : <button className="primary" disabled={!connected || running} onClick={() => startContinuous()} title={t("Run continuously (R)")}>{t("Run")}</button>}
      <div className="progress" title={lastSweepMs ? t("Last sweep {0} s ({1} pts/s)", (lastSweepMs / 1000).toFixed(2), Math.round(points / (lastSweepMs / 1000))) : ""}>
        <div style={{ width: `${(running ? progress : 0) * 100}%` }} />
      </div>
      <select className="theme-select" aria-label={t("Theme")} value={theme} onChange={(e) => setTheme(e.target.value)}>
        <option value="auto">{t("Auto theme")}</option>
        <option value="light">{t("Light")}</option>
        <option value="dark">{t("Dark")}</option>
      </select>
      <LangSelect className="theme-select" />
    </div>
  );
}
