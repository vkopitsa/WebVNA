import { useEffect, useState } from "react";
import { applyUpdate, promptInstall, usePwa } from "../pwa";
import { useT } from "../i18n";

/** Small notices from the service worker: update available, offline ready, install app. */
export function UpdatePrompt() {
  const t = useT();
  const { updateReady, offlineReady, canInstall } = usePwa();
  const [hideUpdate, setHideUpdate] = useState(false);
  const [hideInstall, setHideInstall] = useState(false);
  const [offlineDone, setOfflineDone] = useState(false);

  useEffect(() => {
    if (!offlineReady) return;
    const id = setTimeout(() => setOfflineDone(true), 6000);
    return () => clearTimeout(id);
  }, [offlineReady]);

  const showOffline = offlineReady && !offlineDone;
  const update = updateReady && !hideUpdate;
  const install = canInstall && !hideInstall;
  if (!update && !showOffline && !install) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {update && (
        <div className="toast">
          <span>{t("Update available")}</span>
          <button className="small primary" onClick={applyUpdate}>{t("Reload")}</button>
          <button className="small" onClick={() => setHideUpdate(true)} aria-label={t("Dismiss")}>✕</button>
        </div>
      )}
      {showOffline && (
        <div className="toast">
          <span>{t("Ready to work offline")}</span>
          <button className="small" onClick={() => setOfflineDone(true)} aria-label={t("Dismiss")}>✕</button>
        </div>
      )}
      {install && (
        <div className="toast">
          <span>{t("Install WebVNA as an app")}</span>
          <button className="small primary" onClick={() => void promptInstall()}>{t("Install app")}</button>
          <button className="small" onClick={() => setHideInstall(true)} aria-label={t("Dismiss")}>✕</button>
        </div>
      )}
    </div>
  );
}
