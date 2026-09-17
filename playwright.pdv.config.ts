import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", testMatch: "pdv.spec.ts", workers: 1, timeout: 30000,
  reporter: "list", outputDir: "outputs/pdv-browser/test-results",
  use: { baseURL: "http://127.0.0.1:4186", headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npx tsx scripts/pdv-browser-harness.ts", url: "http://127.0.0.1:4186", timeout: 30000 },
});
