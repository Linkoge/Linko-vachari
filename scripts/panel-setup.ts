import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { privateDir } from '../server/config';
import { hashIdentity, passwordHash } from '../server/access';
if (!process.stdin.isTTY) throw new Error('Use a private interactive operator terminal. Never pass passwords in command arguments.');
let muted = false;
const output = new Writable({ write(chunk, _encoding, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
const prompt = createInterface({ input: process.stdin, output, terminal: true });
async function secret(question: string) { process.stdout.write(question); muted = true; const answer = await prompt.question(''); muted = false; process.stdout.write('\n'); return answer; }
try {
  const logins = await secret('Authorized Tailscale login(s), comma separated (hidden): ');
  const password = await secret('New Linko panel password, at least 12 characters (hidden): ');
  const again = await secret('Repeat panel password (hidden): ');
  if (password !== again || password.length < 12 || password.length > 256 || !logins.trim()) throw new Error('Passwords must match and valid authorized logins are required.');
  const salt = randomBytes(24).toString('hex');
  const value = { salt, passwordHash: passwordHash(password, salt), allowedLoginHashes: logins.split(',').map(hashIdentity).filter(Boolean) };
  await writeFile(join(privateDir, 'access.json'), JSON.stringify(value), { mode: 0o600 });
  console.log('Protected panel configured privately. Activation is still an operator action. No API key is used.');
} finally { prompt.close(); }
