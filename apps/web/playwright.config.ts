import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173", viewport: { width: 1280, height: 800 } },
  webServer: {
    command: "npm run dev --workspace @fleet-radar/web -- --port 4173",
    cwd: "../..",
    port: 4173,
    reuseExistingServer: true,
  },
});

