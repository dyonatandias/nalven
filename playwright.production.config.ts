import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["production.spec.ts", "inventory.spec.ts", "logistics.spec.ts", "shell-navigation.spec.ts"],
  workers: 1,
  timeout: 45000,
  reporter: "list",
  outputDir: "outputs/production-browser/test-results",
  use: { baseURL: "http://127.0.0.1:4179", headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npx tsx scripts/production-browser-harness.ts", url: "http://127.0.0.1:4179", reuseExistingServer: true, timeout: 30000 },
});
