import { create } from "zustand";

/** Service worker / install state, kept apart from the app store (it is never persisted). */
export const usePwa = create<{ updateReady: boolean; offlineReady: boolean; canInstall: boolean }>(() => ({
  updateReady: false, offlineReady: false, canInstall: false,
}));

interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

let registration: ServiceWorkerRegistration | undefined;
let installEvent: InstallPromptEvent | undefined;

/** Registers ./sw.js (production only). The worker waits until the page sends SKIP_WAITING. */
export function registerPwa() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e as InstallPromptEvent; usePwa.setState({ canInstall: true }); });
  window.addEventListener("appinstalled", () => { installEvent = undefined; usePwa.setState({ canInstall: false }); });

  sw.register("./sw.js").then((reg) => {
    registration = reg;
    if (reg.waiting && sw.controller) usePwa.setState({ updateReady: true });
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state !== "installed") return;
        if (sw.controller) usePwa.setState({ updateReady: true }); // an older worker controls the page: this one is waiting
        else usePwa.setState({ offlineReady: true });             // first install: everything is cached
      });
    });
    // Long-lived tabs (an app left open at the bench) still notice new deploys.
    setInterval(() => { void reg.update().catch(() => {}); }, 60 * 60 * 1000);
  }).catch(() => {});
}

/** Activates the waiting worker, then reloads once it has taken control. */
export function applyUpdate() {
  const waiting = registration?.waiting;
  if (!waiting) { location.reload(); return; }
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  waiting.postMessage({ type: "SKIP_WAITING" });
}

export async function promptInstall() {
  const e = installEvent;
  if (!e) return;
  installEvent = undefined;
  usePwa.setState({ canInstall: false });
  await e.prompt();
}
