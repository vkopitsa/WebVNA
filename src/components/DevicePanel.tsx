import { useStore, set } from "../store";
import { Check, Section, Select } from "./inputs";
import { setIfAverage, setPower, setChannelsMode, readVbat, syncClock, screenshot, setSimDut, setSimModel, isSimulator, getStats, download, reconnectKnown, hasWebSerial } from "../controller";
import { DUTS } from "../lib/mock";
import { SIM_MODEL_LABEL } from "../caps";
import { SIM_MODELS } from "../store";
import { useT } from "../i18n";

export function DevicePanel() {
  const s = useStore();
  const t = useT();
  const connected = s.status === "connected";
  const stats = getStats();
  const caps = s.capabilities;
  const has = (k: "screenshot" | "battery" | "ifAverage" | "power" | "channels" | "deviceCal" | "serial" | "clock") => !caps || caps[k];
  const shell = caps?.protocol === "v1-shell";
  const libre = caps?.protocol === "libre";
  return (
    <div>
      <Section title="Device">
        {s.info ? (
          <div className="kv">
            <span>{t("Model")}</span><span>{s.info.model}</span>
            {shell || libre ? <>
              <span>{t("Firmware")}</span><span>{s.info.firmware || "—"}</span>
              <span>{t("Protocol")}</span><span>{libre ? t("LibreVNA packet protocol {0} (experimental)", s.info.protocol) : t("NanoVNA V1/H/H4 text shell (experimental)")}</span>
            </> : <>
              <span>{t("Hardware rev")}</span><span>{s.info.hardware}</span>
              <span>{t("Firmware")}</span><span>{s.info.fwMajor}.{s.info.fwMinor}</span>
              <span>{t("Protocol")}</span><span>{s.info.protocol}</span>
            </>}
            <span>{t("Max points")}</span><span>{s.info.maxPoints}</span>
            {has("serial") && <><span>{t("Serial")}</span><span style={{ fontFamily: "monospace", fontSize: 11 }}>{s.serial || "—"}</span></>}
            {has("battery") && <><span>{t("Battery")}</span><span>{s.vbat != null ? `${s.vbat.toFixed(3)} V` : "—"}</span></>}
            <span>{t("Link")}</span><span>{t(s.linkKind)}</span>
            {stats && <><span>{t("Records")}</span><span>{t("{0} ({1} bad checksum)", stats.records, stats.badChecksum)}</span></>}
            {stats && stats.lastSweepMs > 0 && <><span>{t("Last sweep")}</span><span>{(stats.lastSweepMs / 1000).toFixed(2)} s</span></>}
          </div>
        ) : (
          <>
            <p className="hint">{t("Not connected. Close NanoVNA-App / NanoVNA-Saver first: only one program can open the port.")}</p>
            {hasWebSerial() && <button onClick={() => reconnectKnown()}>{t("Reconnect to a known device")}</button>}
          </>
        )}
        <div className="row" style={{ marginTop: 6 }}>
          {has("battery") && <button disabled={!connected} onClick={() => readVbat()}>{t("Read battery")}</button>}
          {has("clock") && <button disabled={!connected} onClick={() => syncClock()}>{t("Set clock")}</button>}
          {has("screenshot") && <button disabled={!connected} onClick={() => screenshot()}>{t("Screenshot")}</button>}
        </div>
      </Section>

      {(has("ifAverage") || has("power") || has("channels")) && <Section title="Instrument">
        {has("ifAverage") && <div className="row">
          <label>{t("IF averaging")}</label>
          <Select value={s.ifAverage} ariaLabel="IF averaging" options={[1, 2, 3, 5, 10, 20, 40, 80].map((n) => [n, `${n}×`] as [number, string])} onChange={(v) => setIfAverage(v)} />
        </div>}
        {has("power") && <><div className="row">
          <label>{t("Power >140 MHz")}</label>
          <Select value={s.powerHf} ariaLabel="High band power" options={[[0, "0 (−9 dB)"], [1, "1 (−6 dB)"], [2, "2 (−3 dB)"], [3, t("3 (max)")]]} onChange={(v) => setPower({ hf: v })} />
        </div>
        <div className="row">
          <label>{t("Power <140 MHz")}</label>
          <Select value={s.powerLf} ariaLabel="Low band power" options={[[0, "0"], [1, t("1 (default)")], [2, "2"], [3, t("3 (max)")]]} onChange={(v) => setPower({ lf: v })} />
        </div></>}
        {has("channels") && <div className="row">
          <label>{t("Channels")}</label>
          <Select value={s.channelsMode} ariaLabel="Channels" options={[[0, "S11 + S21"], [1, t("S11 only")], [2, t("S21 only")]]} onChange={(v) => setChannelsMode(v)} />
        </div>}
        <p className="hint">{t("Higher IF averaging narrows the IF bandwidth: lower noise, slower sweeps. Defaults: 1×, power 1 / 3, both channels.")}</p>
      </Section>}
      {shell && <Section title="Instrument">
        <p className="hint">{t("This device has no IF averaging, power or channel controls in the shell protocol. Use sweep averaging in the Stimulus tab instead.")}</p>
      </Section>}

      {isSimulator() && (
        <Section title="Simulator">
          <div className="row">
            <label>{t("Simulated model")}</label>
            <Select value={s.simModel} ariaLabel="Simulated model" options={SIM_MODELS.map((m) => [m, t(SIM_MODEL_LABEL[m])] as [typeof m, string])} onChange={(v) => setSimModel(v)} />
          </div>
          <div className="row">
            <label>{t("Device under test")}</label>
            <Select value={s.simDut} ariaLabel="Simulated DUT" options={DUTS.map((d) => [d, t(d)] as [typeof d, string])} onChange={(v) => setSimDut(v)} />
          </div>
          <p className="hint">{t("antenna: 435 MHz dipole · filter: 145 MHz band-pass (S21) · crystal: 10 MHz series (S21) · cable: 3 m open RG-58 · rlc: series RLC.")}</p>
        </Section>
      )}

      {s.screenshot && (
        <Section title="Screenshot" right={<span className="row" style={{ margin: 0 }}>
          <button className="small" onClick={() => fetch(s.screenshot!.url).then((r) => r.blob()).then((b) => download(`litevna-screen-${Date.now()}.png`, b))}>{t("Save PNG")}</button>
          <button className="small" onClick={() => set({ screenshot: null })}>✕</button>
        </span>}>
          <div className="screenshot"><img src={s.screenshot.url} alt={t("Device screen {0}×{1}", s.screenshot.width, s.screenshot.height)} /></div>
        </Section>
      )}

      <Section title="Diagnostics">
        <Check checked={s.commsMonitor} onChange={(v) => set({ commsMonitor: v })}>{t("Comms monitor (hex log of every transfer)")}</Check>
      </Section>
    </div>
  );
}
