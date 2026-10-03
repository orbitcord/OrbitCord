import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
    testDir: './tests', testMatch: 'electron.spec.mjs', workers: 1, reporter: 'line', timeout: 30000,
    outputDir: join(tmpdir(), 'lowcord-electron-results'),
    webServer: { command: 'node tests/fixture-server.mjs', url: 'http://127.0.0.1:4319',
        env: { LOWCORD_FIXTURE_PORT: '4319' }, reuseExistingServer: !process.env.CI },
});
