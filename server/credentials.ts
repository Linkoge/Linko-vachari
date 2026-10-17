import { readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { privateDir } from './config';
import { registerSecret, unregisterSecret } from './secrets';
export const credentialsSchema = z.object({ identifier: z.string().trim().min(3).max(120), password: z.string().min(1).max(256) });
export type Credentials = z.infer<typeof credentialsSchema>;
// MyMarket account credentials live only in this server-side file (mode 0600, inside the ignored private data directory).
// They are never returned by the API, written to the draft journal, sent to Codex or bundled into the client.
export class CredentialVault {
  private value?: Credentials; private source: 'file' | 'environment' | 'none' = 'none';
  constructor(public file = join(privateDir, 'mymarket-account.json')) { this.load(); }
  private load() {
    try { this.value = credentialsSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); this.source = 'file'; }
    catch {
      const { MYMARKET_PHONE: identifier, MYMARKET_PASSWORD: password } = process.env;
      const env = credentialsSchema.safeParse({ identifier, password });
      if (env.success) { this.value = env.data; this.source = 'environment'; } else { this.value = undefined; this.source = 'none'; }
    }
    if (this.value) { registerSecret(this.value.identifier); registerSecret(this.value.password); }
  }
  get configured() { return !!this.value; }
  // Only the login agent calls this; the result must never be logged, serialized or sent to a model.
  get() { return this.value; }
  hint() {
    const id = this.value?.identifier; if (!id) return '';
    return id.includes('@') ? id[0] + '•••@' + id.split('@').pop() : '•••' + id.replace(/\D/g, '').slice(-3);
  }
  status() { return { configured: this.configured, hint: this.hint(), source: this.source }; }
  save(input: unknown) {
    const next = credentialsSchema.parse(input);
    this.forget();
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, this.file);
    this.value = next; this.source = 'file'; registerSecret(next.identifier); registerSecret(next.password);
  }
  forget() {
    if (this.value) { unregisterSecret(this.value.identifier); unregisterSecret(this.value.password); }
    this.value = undefined; this.source = 'none';
  }
  clear() { this.forget(); rmSync(this.file, { force: true }); this.load(); }
}
