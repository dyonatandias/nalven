import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", testMatch: ["support.spec.ts", "portal-shell.spec.ts"], workers: 1, timeout: 30_000,
  reporter: "list", outputDir: "outputs/support-browser/test-results",
  use: { baseURL: "http://127.0.0.1:4181", headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npx tsx scripts/support-browser-harness.ts", url: "http://127.0.0.1:4181", reuseExistingServer: false, timeout: 30_000 },
});
