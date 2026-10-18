import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve('.');
const unitSource = readFileSync('deploy/linko-mymarketer.service', 'utf8');
const legacy = 'mymarketer-main-aaaaaaaaaaaa-20261018';

type Sandbox = ReturnType<typeof sandbox>;
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'linko-deploy-'));
  const p = (...parts: string[]) => join(dir, ...parts);
  for (const d of ['bin', 'root/releases/' + legacy + '/app', 'root/private/browser', 'units', 'config', 'backup']) mkdirSync(p(d), { recursive: true });
  writeFileSync(p('root/private/workspace.sqlite'), 'journal-v1');
  writeFileSync(p('root/private/browser/state'), 'profile');
  writeFileSync(p('config/runtime.env'), `HOST=127.0.0.1\nLINKO_DATA_DIR=${p('root/private')}\nPANEL_NOTE=hidden-marker\n`, { mode: 0o600 });
  // The legacy service is pinned to a release directory rather than the current symlink.
  writeFileSync(p('units/linko-mymarketer.service'), unitSource.replace('releases/current/app', 'releases/' + legacy + '/app'));
  // Fake service manager and package manager: they only log their arguments.
  writeFileSync(p('bin/systemctl'), '#!/usr/bin/env bash\necho "$@" >> "$FAKE_LOG"\nif [ "$1 $2" = "--user is-active" ]; then exit "${FAKE_SERVICE_STATUS:-0}"; fi\n', { mode: 0o755 });
  writeFileSync(p('bin/curl'), `#!/usr/bin/env bash
printf 'curl\\n' >> "$FAKE_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then printf '%s' "$FAKE_HTTP_BODY" > "$2"; shift; fi
  shift
done
printf '%s' "$FAKE_HTTP_STATUS"
exit "\${FAKE_CURL_STATUS:-0}"
`, { mode: 0o755 });
  writeFileSync(p('bin/fakepm'), '#!/usr/bin/env bash\necho "pm $@" >> "$FAKE_LOG"\n[ "${FAKE_PM_FAIL:-}" = "$1" ] && exit 3\nif [ "$1" = install ]; then mkdir node_modules; fi\nif [ "$1" = build ]; then mkdir dist; echo built > dist/index.html; fi\nexit 0\n', { mode: 0o755 });
  const repo = p('repo');
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  writeFileSync(join(repo, 'deploy/linko-mymarketer.service'), unitSource);
  writeFileSync(join(repo, 'package.json'), '{}');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: repo, encoding: 'utf8', timeout: 20_000 }).trim();
  git('init', '--quiet'); git('add', '-A'); git('commit', '--quiet', '-m', 'one');
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${p('bin')}:${process.env.PATH}`, HOME: p('home'), FAKE_LOG: p('fake.log'),
    LINKO_DEPLOY_ROOT: p('root'), DEPLOY_UNIT_DIR: p('units'), DEPLOY_ENV_FILE: p('config/runtime.env'),
    DEPLOY_BACKUP_DIR: p('backup'), DEPLOY_REPO: repo, DEPLOY_COMMIT: git('rev-parse', 'HEAD'),
    DEPLOY_PACKAGE_MANAGER: p('bin/fakepm'),
    DEPLOY_HEALTH_WINDOW_SECONDS: '0', FAKE_HTTP_STATUS: '200',
    FAKE_HTTP_BODY: JSON.stringify({ application: 'linko-mymarketer', releaseId: legacy }), ...extra,
  });
  const script = (name: string, extra: Record<string, string> = {}) => spawnSync(join(repoRoot, 'deploy', name), [], { env: env(extra), encoding: 'utf8', timeout: 60_000 });
  const log = () => (existsSync(p('fake.log')) ? readFileSync(p('fake.log'), 'utf8') : '');
  const releases = () => readdirSync(p('root/releases')).filter(n => /^\d{14}-[0-9a-f]{12}$/.test(n)).sort();
  const current = () => (existsSync(p('root/releases/current')) ? readlinkSync(p('root/releases/current')) : '');
  return { dir, p, repo, git, env, script, log, releases, current, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const sandboxed = (name: string, body: (s: Sandbox) => void | Promise<void>) => test(name, async () => { const s = sandbox(); try { await body(s); } finally { s.cleanup(); } });

test('the unit runs from the releases/current symlink and derives the release id from it', () => {
  assert.match(unitSource, /^WorkingDirectory=\/home\/codex\/\.local\/share\/linko-mymarketer\/releases\/current\/app$/m);
  assert.match(unitSource, /^EnvironmentFile=\/home\/codex\/\.config\/linko-mymarketer\/runtime\.env$/m);
  assert.match(unitSource, /pwd -P/);
  for (const name of ['backup', 'deploy', 'health', 'rollback']) assert.ok(lstatSync(join('deploy', name)).mode & 0o100, `${name} must be executable`);
});

sandboxed('backup records the pinned legacy release, copies private data and prints no environment values', s => {
  const result = s.script('backup');
  assert.equal(result.status, 0, result.stderr);
  const record = readFileSync(s.p('backup/record.env'), 'utf8');
  assert.match(record, new RegExp(`^previous_release=${legacy}$`, 'm'));
  assert.equal(readFileSync(s.p('backup/data/workspace.sqlite'), 'utf8'), 'journal-v1');
  assert.equal(readFileSync(s.p('backup/data/browser/state'), 'utf8'), 'profile');
  assert.ok(!(result.stdout + result.stderr + record).includes('hidden-marker'));
  assert.equal(lstatSync(s.p('backup')).mode & 0o077, 0);
  assert.equal(s.script('backup').status, 0, 'a repeated backup into the same directory succeeds');
});

sandboxed('backup requires a backup directory', s => {
  const result = s.script('backup', { DEPLOY_BACKUP_DIR: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEPLOY_BACKUP_DIR is required/);
});

sandboxed('deploy builds a release from the commit, installs the unit, switches current and restarts', s => {
  const result = s.script('deploy');
  assert.equal(result.status, 0, result.stderr);
  const [id] = s.releases();
  assert.match(id, new RegExp(`^\\d{14}-${s.git('rev-parse', '--short=12', 'HEAD')}$`));
  assert.equal(s.current(), id);
  assert.ok(existsSync(s.p(`root/releases/${id}/app/dist/index.html`)));
  assert.ok(existsSync(s.p(`root/releases/${id}/app/node_modules`)));
  assert.ok(!existsSync(s.p(`root/releases/${id}/app/.git`)));
  assert.match(readFileSync(s.p(`root/releases/${id}/manifest.env`), 'utf8'), /^commit=[0-9a-f]{40}$/m);
  assert.match(readFileSync(s.p('units/linko-mymarketer.service'), 'utf8'), /^WorkingDirectory=.*\/releases\/current\/app$/m);
  assert.match(s.log(), /pm install --frozen-lockfile\npm build\n--user daemon-reload\n--user restart linko-mymarketer\.service\n$/);
  assert.ok(lstatSync(s.p('root/releases/current')).isSymbolicLink());
});

sandboxed('deploy rejects unknown commits and missing settings without touching the service', s => {
  assert.notEqual(s.script('deploy', { DEPLOY_COMMIT: 'deadbeefdeadbeef' }).status, 0);
  assert.notEqual(s.script('deploy', { DEPLOY_COMMIT: '--output=x' }).status, 0);
  assert.notEqual(s.script('deploy', { DEPLOY_REPO: '' }).status, 0);
  assert.notEqual(s.script('deploy', { DEPLOY_ENV_FILE: s.p('missing.env') }).status, 0);
  assert.equal(s.log(), '');
  assert.deepEqual(s.releases(), []);
});

sandboxed('a failed build leaves no partial release, the old unit and no restart', s => {
  const result = s.script('deploy', { FAKE_PM_FAIL: 'build' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(s.releases(), []);
  assert.equal(s.current(), '');
  assert.doesNotMatch(s.log(), /restart/);
  assert.match(readFileSync(s.p('units/linko-mymarketer.service'), 'utf8'), new RegExp(legacy));
});

sandboxed('deploy refuses a commit whose unit does not use the current symlink', s => {
  writeFileSync(join(s.repo, 'deploy/linko-mymarketer.service'), unitSource.replace('releases/current/app', 'releases/pinned/app'));
  s.git('commit', '--quiet', '-am', 'pin');
  const result = s.script('deploy', { DEPLOY_COMMIT: s.git('rev-parse', 'HEAD') });
  assert.notEqual(result.status, 0);
  assert.deepEqual(s.releases(), []);
});

sandboxed('backup, deploy and rollback restore the previous release and optionally the data', s => {
  assert.equal(s.script('backup').status, 0);
  assert.equal(s.script('deploy').status, 0);
  const [deployed] = s.releases();
  assert.equal(s.current(), deployed);
  writeFileSync(s.p('root/private/workspace.sqlite'), 'journal-v2');

  const result = s.script('rollback');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.current(), legacy);
  assert.equal(readFileSync(s.p('root/private/workspace.sqlite'), 'utf8'), 'journal-v2', 'data is kept by default');
  assert.match(s.log(), /--user daemon-reload\n--user restart linko-mymarketer\.service\n$/);
  assert.match(readFileSync(s.p('units/linko-mymarketer.service'), 'utf8'), new RegExp(legacy), 'restores the saved unit');

  assert.equal(s.script('rollback', { DEPLOY_RESTORE_DATA: '1' }).status, 0);
  assert.equal(readFileSync(s.p('root/private/workspace.sqlite'), 'utf8'), 'journal-v1');
  assert.ok(readdirSync(s.p('root')).some(n => n.startsWith('private.pre-rollback.')), 'the replaced data is kept');
});

sandboxed('rollback needs a usable record and a present release', s => {
  assert.match(s.script('rollback').stderr, /no backup record/);
  writeFileSync(s.p('backup/record.env'), 'previous_release=\n');
  writeFileSync(s.p('backup/unit.service'), unitSource);
  assert.match(s.script('rollback').stderr, /no previous release/);
  writeFileSync(s.p('backup/record.env'), 'previous_release=../escape\n');
  assert.match(s.script('rollback').stderr, /invalid release id/);
  writeFileSync(s.p('backup/record.env'), 'previous_release=gone-release\n');
  assert.match(s.script('rollback').stderr, /no longer present/);
  assert.equal(s.log(), '');
});

sandboxed('deploy prunes only its own old releases and keeps the new and previous ones', s => {
  mkdirSync(s.p('root/releases/20200101000000-0123456789ab/app'), { recursive: true });
  mkdirSync(s.p('root/releases/20200102000000-0123456789ab/app'), { recursive: true });
  const result = s.script('deploy', { DEPLOY_KEEP_RELEASES: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.releases().length, 1);
  assert.ok(existsSync(s.p('root/releases/' + legacy + '/app')), 'hand-prepared releases are never pruned');
});

sandboxed('health accepts the matching release or known access boundary with an active service', s => {
  assert.match(s.script('health').stdout, /healthy/);
  for (const [status, message] of [
    ['401', 'Sign in to the Linko panel first. This is separate from MyMarket login.'],
    ['403', 'This panel requires an authorized Tailscale identity through the HTTPS proxy.'],
  ]) {
    const result = s.script('health', { FAKE_HTTP_STATUS: status, FAKE_HTTP_BODY: JSON.stringify({ message }) });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(s.log(), /curl/);
  assert.match(s.log(), /--user is-active --quiet linko-mymarketer.service/);
});

sandboxed('health rejects errors, redirects, stale releases, malformed bodies and inactive services', s => {
  for (const status of ['000', '301', '404', '500', '503']) {
    assert.notEqual(s.script('health', { FAKE_HTTP_STATUS: status }).status, 0, status);
  }
  for (const body of ['{}', 'not-json', JSON.stringify({ application: 'linko-mymarketer', releaseId: 'stale' })]) {
    assert.notEqual(s.script('health', { FAKE_HTTP_BODY: body }).status, 0, body);
  }
  assert.notEqual(s.script('health', { FAKE_SERVICE_STATUS: '1' }).status, 0);
  assert.notEqual(s.script('health', { FAKE_CURL_STATUS: '7' }).status, 0);
  assert.notEqual(s.script('health', { DEPLOY_HEALTH_URL: 'file:///etc/hosts' }).status, 0);
});

sandboxed('first installation rollback stops the service and removes its unit and current link', s => {
  rmSync(s.p('units/linko-mymarketer.service'));
  assert.equal(s.script('backup').status, 0);
  assert.equal(s.script('deploy').status, 0);
  const result = s.script('rollback');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.current(), '');
  assert.ok(!existsSync(s.p('units/linko-mymarketer.service')));
  assert.match(s.log(), /--user stop linko-mymarketer.service/);
});

sandboxed('rollback after a first-install build failure leaves the service manager alone', s => {
  rmSync(s.p('units/linko-mymarketer.service'));
  assert.equal(s.script('backup').status, 0);
  assert.notEqual(s.script('deploy', { FAKE_PM_FAIL: 'build' }).status, 0);
  assert.equal(s.script('rollback').status, 0);
  assert.doesNotMatch(s.log(), /--user/);
});

sandboxed('the saved setup runs every command with defaults for repo, commit and backup directory', s => {
  const setup = JSON.parse(readFileSync('.linko-deploy.json', 'utf8'));
  assert.deepEqual(Object.keys(setup).sort(), ['backup_command', 'deploy_command', 'health_command', 'rollback_command']);
  // Copy the commands into the disposable repository so their default repo is isolated.
  for (const file of ['common.sh', 'backup', 'deploy', 'health', 'rollback']) {
    writeFileSync(join(s.repo, 'deploy', file), readFileSync(join(repoRoot, 'deploy', file)), { mode: 0o755 });
  }
  s.git('add', '.'); s.git('commit', '--quiet', '-m', 'scripts');
  const env = s.env();
  delete (env as Record<string, string>).DEPLOY_REPO;
  delete (env as Record<string, string>).DEPLOY_COMMIT;
  delete (env as Record<string, string>).DEPLOY_BACKUP_DIR;
  for (const key of ['backup_command', 'deploy_command', 'health_command', 'rollback_command']) {
    const argv = setup[key];
    assert.ok(Array.isArray(argv) && argv.every((v: unknown) => typeof v === 'string'));
    if (key === 'health_command') env.FAKE_HTTP_BODY = JSON.stringify({ application: 'linko-mymarketer', releaseId: s.current() });
    const result = spawnSync(argv[0], argv.slice(1), { cwd: s.repo, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, key + ': ' + result.stderr);
  }
  assert.ok(existsSync(s.p('root/backups/pre-deploy/record.env')));
  assert.equal(s.current(), legacy);
});
