import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", testMatch: "auth.spec.ts", workers: 1, timeout: 30_000,
  reporter: "list", outputDir: "outputs/auth-browser/test-results",
  use: { baseURL: "http://127.0.0.1:4180", headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npx tsx scripts/auth-browser-harness.ts", url: "http://127.0.0.1:4180", reuseExistingServer: false, timeout: 30_000 },
});
