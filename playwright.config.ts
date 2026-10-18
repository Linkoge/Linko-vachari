import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/ui', use: { baseURL: 'http://127.0.0.1:4311', headless: true }, workers: 1, reporter: [['list'], ['json', { outputFile: 'docs/evidence/ui-results.json' }]], webServer: { env: { LINKO_DATA_DIR: process.env.LINKO_DATA_DIR || mkdtempSync(join(tmpdir(), 'linko-ui-')), ALLOW_PUBLISH: 'false', LINKO_AUTO_RELIST: 'false' }, command: 'PORT=4311 LINKO_CODEX_BINARY="$PWD/tests/fixtures/codex-fixture.mjs" NODE_ENV=production corepack pnpm exec tsx server/index.ts', url: 'http://127.0.0.1:4311', reuseExistingServer: false } });
