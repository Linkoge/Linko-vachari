import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import '../server/config';
import { isSecretFile, trackedSecretFiles } from './secret-files';
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).filter(file => { try { return statSync(file).isFile(); } catch { return false; } });
const violations: string[] = [];
for (const file of trackedSecretFiles()) violations.push('Private file is tracked: ' + file);
function scan(file: string, data: Buffer, location = file) {
  if (isSecretFile(file) || /^(node_modules\/|dist\/)/.test(file)) violations.push('Private file would be tracked: ' + location);
  if (data.includes(0) || /\.(png|jpg|webp|ico)$/.test(file)) return;
  const text = data.toString();
  if (/\bsk-(?:proj-)?[a-zA-Z0-9_-]{24,}/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) violations.push('Potential secret in: ' + location);
  for (const name of ['MYMARKET_PHONE', 'MYMARKET_PASSWORD']) { const secret = process.env[name]; if (secret && secret.length >= 6 && text.includes(secret)) violations.push('Configured project secret detected in: ' + location); }
}
for (const file of files) scan(file, readFileSync(file));
// Inspect this project's reachable committed files, never unrelated auth/secret stores.
const commits = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const historicalBlobs = new Set<string>();
for (const commit of commits) {
  const entries = execFileSync('git', ['ls-tree', '-rz', commit], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const entry of entries) {
    const [metadata, file] = entry.split('\t'); const [, type, object] = metadata.split(' ');
    if (type !== 'blob' || historicalBlobs.has(object)) continue;
    historicalBlobs.add(object);
    scan(file, execFileSync('git', ['cat-file', 'blob', object], { maxBuffer: 32 * 1024 * 1024 }), commit.slice(0, 12) + ':' + file);
  }
}
const ignored = ['.env', '.env.production', '.private/browser/Default/Cookies', '.private/workspace.sqlite', '.private/photos/example.jpg', '.private/access.json', '.private/mymarket-account.json', 'mymarket-account.json', '.private/codex-job-test/result.json', 'storage-state.json', 'credentials.json', 'auth.json', 'run.log'];
for (const path of ignored) { try { execFileSync('git', ['check-ignore', '-q', path]); } catch { violations.push('Missing ignore rule: ' + path); } }
function scanBundle(dir: string) {
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) scanBundle(p); else if (/\.(js|css|html)$/.test(f)) {
    const text = readFileSync(p, 'utf8');
    if (text.includes('MYMARKET_PASSWORD') || text.includes('node:sqlite') || text.includes('launchPersistentContext') || text.includes('OPENAI_API_KEY') || text.includes('CODEX_API_KEY') || text.includes('passwordHash') || text.includes('mymarket-account') || text.includes('auth.json')) violations.push('Server implementation or credential configuration in client bundle: ' + p);
    for (const name of ['MYMARKET_PHONE', 'MYMARKET_PASSWORD']) { const secret = process.env[name]; if (secret && secret.length >= 6 && text.includes(secret)) violations.push('Configured project secret detected in bundle: ' + p); }
  } }
}
scanBundle('dist');
if (violations.length) { console.error(violations.join('\n')); process.exit(1); }
console.log(JSON.stringify({ passed: true, checkedFiles: files.length, historicalCommits: commits.length, historicalBlobs: historicalBlobs.size, ignoreCases: ignored.length, clientBundle: 'No server implementation, provider-key configuration or configured project secret detected', nativeCodexAuthStoreInspected: false, limitations: 'Pattern scan and configured-project-secret checks; original owner credentials unavailable. Native credentials are owned by Codex and were never inspected.' }, null, 2));
