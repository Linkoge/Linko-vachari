import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashIdentity, passwordHash } from '../server/access';

const origin = 'https://owner-node.test-tailnet.ts.net:8443';
const login = 'owner@example.invalid';
function inspectConfig(auth: string | undefined, publicOrigin = origin, host = '127.0.0.1', startServer = false) {
  const dir = mkdtempSync(join(tmpdir(), 'linko-config-'));
  const salt = randomBytes(24).toString('hex');
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ salt, passwordHash: passwordHash(randomBytes(24).toString('hex'), salt), allowedLoginHashes: [hashIdentity(login)] }));
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: join(dir, 'absent.env'), LINKO_DATA_DIR: dir, LINKO_PUBLIC_ORIGIN: publicOrigin, HOST: host, PORT: '0', NODE_ENV: 'production' };
  if (auth === undefined) delete env.LINKO_PANEL_AUTH;
  else env.LINKO_PANEL_AUTH = auth;
  try {
    // Fresh processes exercise actual environment parsing and private allowlist loading.
    const args = startServer ? ['--import', 'tsx', 'server/index.ts'] : ['--import', 'tsx', '--input-type=module', '-e', `
      const { AccessBoundary } = await import('./server/access.ts');
      const access = new AccessBoundary();
      console.log(JSON.stringify({ protected: access.protected, identity: access.identity({
        headers: { host: new URL(${JSON.stringify(origin)}).host, 'x-forwarded-proto': 'https', 'tailscale-user-login': ${JSON.stringify(login)} },
        socket: { remoteAddress: '127.0.0.1' }
      }) }));
    `];
    return spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('only explicit false overrides the password-protected tailnet default, retaining the loaded allowlist', () => {
  for (const value of [undefined, '', 'true', 'FALSE', 'invalid', 'false']) {
    const result = inspectConfig(value);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { protected: value !== 'false', identity: hashIdentity(login) }, `LINKO_PANEL_AUTH=${value}`);
  }
});

test('trusted local mode keeps its default and supports explicit password protection', () => {
  for (const value of [undefined, 'false', 'true']) {
    const result = inspectConfig(value, '');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { protected: value === 'true', identity: 'local' });
  }
});

test('passwordless configuration only permits loopback listener addresses, with or without a tailnet origin', () => {
  for (const publicOrigin of [origin, '']) {
    for (const host of ['0.0.0.0', '::', '100.64.0.20', '192.168.1.20']) {
      const result = inspectConfig('false', publicOrigin, host, true);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /must bind loopback/);
    }
  }
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const result = inspectConfig('false', origin, host);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('password opt-out does not accept a public or malformed origin', () => {
  for (const publicOrigin of ['https://public.example', 'http://owner-node.test-tailnet.ts.net:8443', origin + '/path']) {
    const result = inspectConfig('false', publicOrigin);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /exact HTTPS Tailscale hostname/);
  }
});
