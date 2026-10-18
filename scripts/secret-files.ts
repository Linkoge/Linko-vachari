import { execFileSync } from 'node:child_process';

// File policy shared by the repository regression suite and security:check.
// Source modules such as server/credentials.ts are safe; credential data is not.
export function isSecretFile(file: string): boolean {
  const path = file.replaceAll('\\', '/').toLowerCase();
  const parts = path.split('/');
  const name = parts.at(-1)!;
  if (parts.some(part => ['.private', '.ssh', '.aws', 'credentials', 'cookies', 'tokens', 'sessions', 'secrets'].includes(part))) return true;
  if (name === '.env.example' || name === 'runtime.env.example') return false;
  if (/^settings\.json(?:$|\.)/.test(name)) return true;
  if (/\.env(?:$|\.)/.test(name)) return true;
  if (/\.(pem|key|p12|pfx|keystore)(?:$|\.)/.test(name)) return true;
  if (['auth', 'credential', 'cookie', 'token', 'session', 'secret', 'cookies', 'cookies-journal', 'login data', 'login data-journal', 'local state', '.git-credentials', '.netrc', '_netrc', '.npmrc', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'].includes(name)) return true;
  return /(?:auth|credential|cookie|token|session|secret|storage[-_]?state|mymarket[-_]?account)[^/]*\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|txt|csv|db|sqlite\d*)(?:$|\.)/.test(name);
}

export function trackedSecretFiles(cwd = process.cwd()): string[] {
  // Inspect the index, including staged additions and files missing from disk.
  return execFileSync('git', ['ls-files', '--cached', '-z'], { cwd, encoding: 'utf8', timeout: 10_000 })
    .split('\0').filter(file => file && isSecretFile(file));
}
