import 'dotenv/config';
import { resolve } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';
process.umask(0o077);
export const privateDir = resolve(process.env.LINKO_DATA_DIR || '.private');
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
chmodSync(privateDir, 0o700);
export const config = {
  port: Number(process.env.PORT || 4310), host: process.env.HOST || '127.0.0.1',
  codexBinary: process.env.LINKO_CODEX_BINARY || 'codex', claudeBinary: process.env.LINKO_CLAUDE_BINARY || 'claude',
  codexTimeout: Number(process.env.LINKO_CODEX_TIMEOUT_MS || 180_000),
  publicOrigin: process.env.LINKO_PUBLIC_ORIGIN || '',
  // An unset value keeps the origin-dependent default; only exact false opts out.
  panelAuth: process.env.LINKO_PANEL_AUTH === 'false' ? false : process.env.LINKO_PANEL_AUTH === 'true' ? true : undefined,
  releaseId: process.env.LINKO_RELEASE_ID || 'development',
  headless: process.env.HEADLESS === 'true', publish: process.env.ALLOW_PUBLISH === 'true',
  autoRelist: process.env.LINKO_AUTO_RELIST === 'true',
};
if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  throw new Error('The application must bind loopback. Remote access uses a trusted Tailscale Serve HTTPS proxy.');
}
if (config.publicOrigin && !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(?::\d+)?$/.test(config.publicOrigin)) throw new Error('LINKO_PUBLIC_ORIGIN must be the exact HTTPS Tailscale hostname, with optional port and no path.');
