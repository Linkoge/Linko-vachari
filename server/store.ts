import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { privateDir } from './config';
import { Draft, WorkflowError } from './types';
export class Store {
  db: DatabaseSync;
  constructor(path = join(privateDir, 'workspace.sqlite')) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(fingerprint TEXT PRIMARY KEY, draft TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT);`);
  }
  create() {
    const d: Draft = { id: randomUUID(), revision: 0, state: 'draft', title: '', description: '', price: '', currency: 'GEL', model: '', condition: '', location: '', facts: {}, photos: [], coverId: '', category: [], comparables: [], questions: [], fields: [], message: 'Add your photos and a few details to begin.', events: [] };
    this.save(d); return d;
  }
  get(id: string): Draft {
    const row = this.db.prepare('SELECT data FROM drafts WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new WorkflowError('NOT_FOUND', 'This draft could not be found. Start a new one.');
    const d = JSON.parse(row.data) as Draft & { coverManual?: boolean };
    d.photos = d.photos.map(p => ({ id: p.id, width: p.width, height: p.height })); delete d.coverManual;
    return d;
  }
  save(d: Draft) { this.db.prepare('INSERT OR REPLACE INTO drafts VALUES (?,?)').run(d.id, JSON.stringify(d)); }
  event(d: Draft, message: string) {
    d.message = message; d.events.push({ at: new Date().toISOString(), message });
    d.events = d.events.slice(-80); this.save(d);
  }
  fingerprint(d: Draft) {
    // Covers content across draft IDs and file names; photo bytes are canonical, EXIF-free JPEGs.
    const photos = d.photos.map(p => createHash('sha256').update(readFileSync(join(privateDir, 'photos', p.id + '.jpg'))).digest('hex')).sort();
    return createHash('sha256').update(JSON.stringify({ title: d.title.trim(), description: d.description.trim(), price: Number(d.price), currency: d.currency, model: d.model, photos })).digest('hex');
  }
  claim(d: Draft) {
    const fp = this.fingerprint(d);
    try { this.db.prepare('INSERT INTO attempts VALUES (?,?,?,NULL)').run(fp, d.id, 'publishing'); }
    catch { throw new WorkflowError('DUPLICATE', 'This item already has a publishing attempt. Check your MyMarket account before doing anything else. Automatic reposting is disabled.'); }
    return fp;
  }
  finish(fp: string, state: string, receipt?: Draft['receipt']) {
    this.db.prepare('UPDATE attempts SET state=?,receipt=? WHERE fingerprint=?').run(state, receipt ? JSON.stringify(receipt) : null, fp);
  }
  recover() {
    for (const row of this.db.prepare('SELECT data FROM drafts').all() as { data: string }[]) {
      const d = this.get((JSON.parse(row.data) as Draft).id);
      if (/AI provider key|AI service|Looking at your photos/i.test(d.message)) { d.message = 'Draft restored. Choose your main photo and continue with Codex.'; this.save(d); }
      if (d.state === 'publishing') { d.state = 'unknown'; this.event(d, 'The connection ended during publishing. Check MyMarket; this item will not be automatically submitted again.'); }
      else if (['analyzing', 'preparing', 'ready'].includes(d.state)) { d.state = 'blocked'; delete d.preparedRevision; this.event(d, 'The browser session ended. Your draft is safe. Prepare it again to inspect the current form.'); }
    }
    this.db.prepare("UPDATE attempts SET state='unknown' WHERE state='publishing'").run();
  }
}
