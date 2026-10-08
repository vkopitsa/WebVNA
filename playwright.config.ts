import { defineConfig, devices } from "@playwright/test";

// Local runs use the system Chrome; CI sets PW_CHANNEL="" and installs the bundled chromium.
const channel = process.env.PW_CHANNEL ?? (process.env.CI ? "" : "chrome");

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:4173/",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    acceptDownloads: true,
    ...devices["Desktop Chrome"],
    ...(channel ? { channel } : {}),
  },
  // The production build: closest to what ships and it exercises the service worker.
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173/",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
