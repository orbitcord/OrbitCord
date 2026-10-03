import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
    testDir: "./tests",
    testMatch: "**/*.spec.mjs",
    testIgnore: "**/electron.spec.mjs",
    outputDir: join(tmpdir(), "lowcord-playwright-results"),
    fullyParallel: true,
    workers: 4,
    reporter: "line",
    use: { baseURL: "http://127.0.0.1:4318", viewport: { width: 1000, height: 800 } },
    webServer: { command: "node tests/fixture-server.mjs", url: "http://127.0.0.1:4318", reuseExistingServer: !process.env.CI },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }]
});
