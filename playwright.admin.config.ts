import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir:"./tests/browser", testMatch:"admin.spec.ts", fullyParallel:false,
  use:{baseURL:"http://127.0.0.1:4184",headless:true},
  webServer:{command:"npx tsx scripts/admin-browser-harness.ts",url:"http://127.0.0.1:4184",reuseExistingServer:false},
});
