// Loose typing for the page-side scripting API (the real types live in src/api.ts).
export {};
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webvna: any;
  }
}
