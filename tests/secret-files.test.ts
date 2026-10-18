import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSecretFile, trackedSecretFiles } from '../scripts/secret-files';

const privatePaths = [
  'settings.json', 'nested/settings.json.tmp',
  '.env', '.env.local', 'nested/.env.production', 'deploy/runtime.env',
  'nested/client.pem', 'nested/client.key', 'client.pem.bak', 'client.p12', 'client.pfx', 'client.keystore',
  'credentials.json', 'nested/service-credentials.json', 'credentials.json.bak',
  'cookies.json', 'browser-cookies.txt', 'access-token.json', 'refresh-token.yaml',
  'session.yml', 'sessions.json', 'client-secret.json', 'storage-state.json', 'storage_state.json',
  'mymarket-account.json', 'auth.json', '.private/access.json', '.private/browser/Default/Cookies',
  'nested/credentials/account', 'cookies/account', 'tokens/account', 'sessions/account', 'secrets/account',
  '.ssh/id_ed25519', '.aws/credentials', '.netrc', '.npmrc', '.git-credentials', 'id_rsa', 'Cookies', 'Login Data', 'Local State',
  'auth', 'credential', 'cookie', 'token', 'session', 'secret',
];

test('no credential or session data files are tracked in the repository index', () => {
  // Even an ignored file can be force-added. check-ignore alone cannot detect that.
  assert.deepEqual(trackedSecretFiles(), [], 'Untrack private files with git rm --cached; preserve the local copies');
});

test('private file patterns are ignored and rejected when force-added, with local copies preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linko-secret-files-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  try {
    git('init', '--quiet');
    writeFileSync(join(dir, '.gitignore'), readFileSync('.gitignore'));
    for (const file of privatePaths) {
      assert.equal(isSecretFile(file), true, file);
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), 'fake-test-data-only', { mode: 0o600 });
      git('check-ignore', '-q', '--', file);
    }
    git('add', '--force', '--', ...privatePaths);
    assert.deepEqual(trackedSecretFiles(dir).sort(), [...privatePaths].sort());
    // A missing working copy must not conceal a secret still present in the index.
    rmSync(join(dir, '.env'));
    assert.ok(trackedSecretFiles(dir).includes('.env'));
    git('rm', '--cached', '--quiet', '--', ...privatePaths);
    assert.deepEqual(trackedSecretFiles(dir), []);
    assert.equal(readFileSync(join(dir, 'credentials.json'), 'utf8'), 'fake-test-data-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source code and the two explicit empty environment templates remain trackable', () => {
  for (const file of ['.env.example', 'deploy/runtime.env.example', 'server/credentials.ts', 'server/secrets.ts', 'tests/secret-files.test.ts', 'tests/fixtures/market-fixture.ts']) {
    assert.equal(isSecretFile(file), false, file);
  }
  for (const file of ['.env.example', 'deploy/runtime.env.example']) {
    const populated = readFileSync(file, 'utf8').split('\n').some(line => /^\s*(?:MYMARKET_(?:PHONE|PASSWORD)|[A-Z_]*(?:TOKEN|SECRET|API_KEY))\s*=\s*[^\s#]/.test(line));
    assert.equal(populated, false, 'Credential template must contain empty placeholders: ' + file);
  }
});

test('the application loads local dotenv credentials and prefers the saved private vault', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linko-local-credentials-'));
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: join(dir, '.env'), LINKO_DATA_DIR: join(dir, '.private') };
  delete env.MYMARKET_PHONE;
  delete env.MYMARKET_PASSWORD;
  try {
    writeFileSync(join(dir, '.env'), 'MYMARKET_PHONE=fake-local-owner\nMYMARKET_PASSWORD=fake-local-password\n', { mode: 0o600 });
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { CredentialVault } from './server/credentials.ts';
      import { randomUUID } from 'node:crypto';
      const fixtureValue = 'synthetic-' + randomUUID();
      const vault = new CredentialVault();
      assert.equal(vault.status().source, 'environment');
      assert.equal(vault.get()?.identifier, 'fake-local-owner');
      assert.equal(vault.get()?.password, 'fake-local-password');
      vault.save({ identifier: 'fake-vault-owner', password: fixtureValue });
      const reloaded = new CredentialVault();
      assert.equal(reloaded.status().source, 'file');
      assert.equal(reloaded.get()?.password, fixtureValue);
    `], { env, timeout: 20_000, stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
