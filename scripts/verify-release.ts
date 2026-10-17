import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../server/config';

const id = process.argv[2];
if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Supply the prepared release_id.');
const dir = join(privateDir, 'releases', id);
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function check(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
check(manifest.release_id === id && manifest.state === 'prepared' && manifest.activationPerformed === false, 'Unexpected preparation state.');
for (const [name, expected] of [['source.bundle', manifest.sourceBundleSha256], ['app.tar.gz', manifest.appArtifactSha256]]) {
  check(digest(await readFile(join(dir, name))) === expected, 'Artifact checksum mismatch: ' + name);
}
execFileSync('git', ['bundle', 'verify', join(dir, 'source.bundle')], { stdio: 'pipe' });
const refs = execFileSync('git', ['bundle', 'list-heads', join(dir, 'source.bundle')], { encoding: 'utf8' });
check(refs.trim() === manifest.commit + ' HEAD', 'Source bundle does not match the prepared commit.');
const archive = join(dir, 'app.tar.gz');
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
for (const entry of entries) {
  check(!entry.startsWith('/') && !entry.split('/').includes('..'), 'Unsafe archive path.');
  check(/^(dist\/|server\/|scripts\/|deploy\/|docs\/EXECUTION_REPORT\.md$|README\.md$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig\.json$)/.test(entry), 'Unexpected runtime archive member.');
  check(!/(^|\/)(?:\.private|\.env(?:\.[^/]+)?|auth\.json|credentials\.json|storage-state[^/]*|[^/]+\.(?:sqlite|db|pem|key))(?:\/|$)/.test(entry), 'Private runtime data in archive.');
}
for (const [file, expected] of Object.entries(manifest.assets)) {
  check(/^[a-zA-Z0-9_.-]+$/.test(file), 'Unsafe asset name.');
  check(digest(execFileSync('tar', ['-xOzf', archive, 'dist/assets/' + file])) === expected, 'Built asset checksum mismatch.');
}
for (const [file, expected] of Object.entries(manifest.checks)) {
  check(/^[a-zA-Z0-9_.-]+$/.test(file), 'Unsafe evidence name.');
  check(digest(await readFile('docs/evidence/' + file)) === expected, 'Evidence checksum mismatch.');
}
const receipt = { checkedAt: new Date().toISOString(), release_id: id, commit: manifest.commit, passed: true,
  artifactSha256: manifest.appArtifactSha256, sourceBundleVerified: true, archiveMembers: entries.length,
  privateRuntimeExcluded: true, checkedAssets: Object.keys(manifest.assets).length,
  checkedEvidenceFiles: Object.keys(manifest.checks).length, activationPerformed: false, realListingsPublished: 0 };
await writeFile(join(dir, 'verification.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
