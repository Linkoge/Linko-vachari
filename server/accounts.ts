import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { CredentialVault, credentialsSchema, type Credentials } from './credentials';
import { registerSecret } from './secrets';
import { WorkflowError } from './types';
import type { Store } from './store';

const account = z.object({ id: z.string(), label: z.string(), credentials: credentialsSchema.optional(), removed: z.boolean().optional(), initialized: z.boolean().optional(), identityHash: z.string().optional() });
const schema = z.object({ version: z.literal(1), lastUsed: z.string(), accounts: z.array(account) });
export const addAccountSchema = credentialsSchema.extend({ label: z.string().trim().min(1).max(80) }).strict();
const identity = (identifier: string) => createHash('sha256').update(identifier.trim().toLocaleLowerCase()).digest('hex');
type Account = z.infer<typeof account>;
/** The only account document containing credentials is private, atomic and never returned by APIs. */
export class Accounts {
  private data: z.infer<typeof schema>;
  file: string;
  constructor(public legacy: CredentialVault, public store: Store) {
    this.file = join(dirname(legacy.file), 'mymarket-accounts.json');
    if (existsSync(this.file)) this.data = schema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    else {
      this.data = { version: 1, lastUsed: 'legacy', accounts: [{ id: 'legacy', label: 'MyMarket', credentials: legacy.get(), initialized: !!legacy.get() || existsSync(join(dirname(legacy.file), 'browser')) }] };
      this.persist();
    }
    // A tombstone prevents removed environment credentials from reappearing after restart.
    for (const a of this.data.accounts) if (a.credentials) { a.initialized = true; a.identityHash = identity(a.credentials.identifier); registerSecret(a.credentials.identifier); registerSecret(a.credentials.password); }
    this.persist(); this.migrate();
  }
  private persist() {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 }); chmodSync(this.file + '.tmp', 0o600); renameSync(this.file + '.tmp', this.file);
  }
  private migrate() {
    for (const table of ['drafts', 'listing_records']) {
      for (const row of this.store.db.prepare(`SELECT id,data FROM ${table}`).all() as { id: string; data: string }[]) {
        const value = JSON.parse(row.data), draft = table === 'drafts' ? value : value.recipe;
        if (!draft.accountId) { draft.accountId = 'legacy'; this.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), row.id); }
      }
    }
  }
  get defaultId() { return this.data.lastUsed; }
  require(id = this.defaultId): Account {
    const a = this.data.accounts.find(a => a.id === id && !a.removed);
    if (!a) throw new WorkflowError('ACCOUNT', 'This MyMarket account was removed. Choose an available account in Settings.');
    return a;
  }
  use(id: string) { this.require(id); if (this.data.lastUsed !== id) { this.data.lastUsed = id; this.persist(); } }
  view() {
    const records = this.store.db.prepare('SELECT data FROM listing_records').all() as { data: string }[];
    return this.data.accounts.filter(a => !a.removed).map(a => {
      const urls = new Set<string>();
      for (const row of records) {
        const r = JSON.parse(row.data);
        // Inconclusive/attention checks do not prove removal. Pausing monitoring does not free a slot.
        if ((r.recipe.accountId || 'legacy') === a.id && r.receipt && !['missing', 'replaced', 'deleted_by_owner'].includes(r.status)) urls.add(r.receipt.url);
      }
      const v = this.vault(a.id);
      return { id: a.id, label: a.label, ...v.status(), activeListings: urls.size, freeLimit: 5 };
    });
  }
  add(input: unknown) {
    const { label, ...credentials } = addAccountSchema.parse(input);
    const placeholder = this.data.accounts.find(a => a.id === 'legacy' && !a.removed && !a.credentials && !a.initialized);
    const a: Account = placeholder || { id: randomUUID(), label };
    a.label = label; a.credentials = credentials; a.initialized = true; a.identityHash = identity(credentials.identifier);
    if (!placeholder) this.data.accounts.push(a);
    registerSecret(credentials.identifier); registerSecret(credentials.password);
    this.data.lastUsed = a.id; this.persist(); return a.id;
  }
  remove(id: string) {
    const a = this.require(id); delete a.credentials; a.removed = true;
    if (id === 'legacy') this.legacy.clear();
    if (id === this.data.lastUsed) this.data.lastUsed = this.data.accounts.find(a => !a.removed)?.id || '';
    this.persist();
    // Retain profiles and journal references for recovery; they are never assigned to another account.
  }
  vault(id: string): CredentialVault {
    const owner = this;
    return new class extends CredentialVault {
      constructor() { super(join(dirname(owner.file), 'unused-vault'), false); }
      override get configured() { return !!this.get(); }
      override get() { return owner.data.accounts.find(a => a.id === id && !a.removed)?.credentials; }
      override status(): ReturnType<CredentialVault['status']> { return { configured: this.configured, hint: this.hint(), source: this.configured ? 'file' : 'none' }; }
      override hint() { const value = this.get()?.identifier; return !value ? '' : value.includes('@') ? value[0] + '•••@' + value.split('@').pop() : '•••' + value.replace(/\D/g, '').slice(-3); }
      override save(input: unknown) {
        const next: Credentials = credentialsSchema.parse(input), a = owner.require(id);
        if (a.initialized && a.identityHash !== identity(next.identifier)) throw new WorkflowError('ACCOUNT', 'Add a separate account in Settings to use another email or phone.');
        a.credentials = next; a.identityHash = identity(next.identifier); a.initialized = true;
        if (id === 'legacy') owner.legacy.save(next);
        registerSecret(next.identifier); registerSecret(next.password); owner.persist();
      }
      override clear() { delete owner.require(id).credentials; if (id === 'legacy') owner.legacy.clear(); owner.persist(); }
    }();
  }
}
