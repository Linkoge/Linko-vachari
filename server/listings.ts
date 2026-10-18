import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isListingUrl, onAuthPage } from './browser';
import type { Store } from './store';
import type { Workflow } from './workflow';
import { Draft, WorkflowError } from './types';

export const CHECK_INTERVAL = 3 * 60 * 60_000;
export const MISSING_RECHECK = 60 * 60_000;
export interface ListingRecord {
  id: string; recipe: Draft; fingerprint: string; receipt?: Draft['receipt'];
  enabled: boolean; status: 'unverified' | 'active' | 'missing' | 'unavailable' | 'relisting' | 'replaced' | 'attention' | 'deleting' | 'deleted_by_owner';
  missingCount: number; firstMissingAt?: number; checkedAt?: number; nextCheckAt: number;
  message: string; replacementId?: string; deleteRequestedAt?: number; deletionNotified?: boolean;
}
// JSON string literals preserve Markdown/newlines verbatim without allowing item text to alter the document.
const literal = (value: unknown) => JSON.stringify(value).replace(/`/g, '\\u0060');
export function listingMarkdown(r: ListingRecord) {
  const d = r.recipe;
  return `# MyMarket listing record\n\n` +
    `Account: ${d.accountId || 'legacy'}\n\nCategory method: ${d.categoryMethod || 'comparable-search'}\n\nDraft: ${d.id}\n\nStatus: ${r.status}\n\nMonitoring: ${r.enabled ? 'enabled' : 'paused'}\n\n` +
    `Receipt: ${literal(r.receipt || null)}\n\nReplacement draft: ${r.replacementId || 'none'}\n\n` +
    `Last check: ${r.checkedAt ? new Date(r.checkedAt).toISOString() : 'not checked'}\n\n${r.message}\n\n` +
    `## Category / section\n\n${literal(d.category)}\n\n` +
    `## Listing text and price (exact JSON strings)\n\n` +
    ['title', 'description', 'price', 'currency', 'model', 'condition', 'location'].map(k => `- ${k}: ${literal(d[k as keyof Draft])}`).join('\n') +
    `\n\n## Supplied facts\n\n${Object.entries(d.facts).map(([k, v]) => `- ${literal(k)}: ${literal(v)}`).join('\n')}\n\n` +
    `## Observed form fields\n\n${d.fields.map(f => `- ${literal(f.label)} = ${literal(f.value)} (source: ${literal(f.source)})`).join('\n')}\n\n` +
    `## Photos in upload order (first is cover)\n\n` +
    [d.coverId, ...d.photos.map(p => p.id).filter(id => id !== d.coverId)].filter(Boolean).map((id, i) => `${i + 1}. ../photos/${id}.jpg`).join('\n') +
    `\n\nKeep this private data directory, its photos and workspace.sqlite together. The immutable recipe is also stored in SQLite.\n`;
}
export class ListingArchive {
  constructor(public store: Store) {}
  all(): ListingRecord[] {
    return (this.store.db.prepare('SELECT data FROM listing_records ORDER BY rowid').all() as { data: string }[]).map(r => JSON.parse(r.data));
  }
  get(id: string): ListingRecord {
    const row = this.store.db.prepare('SELECT data FROM listing_records WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new WorkflowError('NOT_FOUND', 'Listing record not found.');
    return JSON.parse(row.data);
  }
  write(r: ListingRecord) {
    // Persist the journal first: a failed Markdown write must never erase a submit claim or a receipt.
    this.store.db.prepare('INSERT OR REPLACE INTO listing_records VALUES (?,?)').run(r.id, JSON.stringify(r));
    mkdirSync(this.store.archiveDir, { recursive: true, mode: 0o700 });
    const file = join(this.store.archiveDir, r.id + '.md');
    writeFileSync(file + '.tmp', listingMarkdown(r), { mode: 0o600 }); renameSync(file + '.tmp', file);
  }
  snapshot(d: Draft) {
    const existing = this.all().find(r => r.id === d.id);
    const attempted = this.store.db.prepare('SELECT 1 FROM attempts WHERE draft=?').get(d.id);
    if (existing && (existing.receipt || attempted || d.state !== 'ready')) { this.write(existing); return existing; }
    const recipe = structuredClone(d); recipe.events = []; delete recipe.receipt;
    const r: ListingRecord = { id: d.id, recipe, fingerprint: this.store.fingerprint(d), enabled: existing?.enabled ?? true, status: 'unverified', missingCount: 0, nextCheckAt: Date.now() + CHECK_INTERVAL, message: 'Saved before submission; publication is not yet verified.' };
    this.write(r); return r;
  }
  published(d: Draft) {
    if (d.state !== 'published' || !d.receipt || !isListingUrl(d.receipt.url)) return;
    const r = this.snapshot(d);
    if (d.automation) r.recipe.automation = structuredClone(d.automation);
    if (!r.receipt) { r.receipt = d.receipt; r.status = 'active'; r.message = 'Published and verified. Scheduled for checks every three hours.'; this.write(r); }
  }
  recover() {
    // Backfill older successful listings and finish records after a crash between receipt and archive writes.
    for (const row of this.store.db.prepare('SELECT data FROM drafts').all() as { data: string }[]) {
      const d: Draft = JSON.parse(row.data);
      try { this.published(d); }
      catch {
        if (d.state !== 'published' || !d.receipt) continue;
        const existing = this.all().find(r => r.id === d.id);
        const recipe = structuredClone(d); recipe.events = []; delete recipe.receipt;
        const r: ListingRecord = existing || { id: d.id, recipe, fingerprint: '', enabled: true, status: 'attention', missingCount: 0, nextCheckAt: Date.now() + CHECK_INTERVAL, message: '' };
        r.status = 'attention'; r.receipt = d.receipt; r.message = 'The listing record or saved photos need repair. Automatic re-listing is stopped.'; this.write(r);
      }
    }
    for (const r of this.all()) {
      if (r.deleteRequestedAt) {
        r.enabled = false;
        if (r.status !== 'deleted_by_owner') { r.status = 'attention'; r.message = 'Owner deletion may have been interrupted. Inspect MyMarket. This item will never be automatically re-listed.'; }
      }
      if (r.status === 'relisting') {
        const replacement = r.replacementId && this.store.get(r.replacementId);
        r.status = replacement && replacement.state === 'published' ? 'replaced' : 'attention';
        r.message = r.status === 'replaced' ? 'Replacement verified; monitoring continues on its record.' : 'Re-listing was interrupted. Inspect MyMarket before taking further action.';
      }
      this.write(r);
    }
  }
  pause(id: string, enabled: boolean) {
    const r = this.get(id);
    if (r.deleteRequestedAt || ['deleting','deleted_by_owner','replaced','relisting'].includes(r.status)) throw new WorkflowError('LOCKED', 'This record is permanently retired from monitoring.');
    r.enabled = enabled; r.missingCount = 0; delete r.firstMissingAt;
    r.nextCheckAt = Date.now(); this.write(r); return r;
  }
}
export type Availability = 'active' | 'missing' | 'unavailable';
export class ListingMonitor {
  timer?: ReturnType<typeof setInterval>;
  constructor(public workflow: Workflow, public archive = workflow.archive, public probe: (r: ListingRecord) => Promise<Availability> = r => this.inspect(r)) {}
  start() {
    this.timer = setInterval(() => { void this.check().catch(() => {}); }, 60_000); this.timer.unref();
    void this.check().catch(() => {});
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  async inspect(r: ListingRecord, retried = false): Promise<Availability> {
    if (!r.receipt || !isListingUrl(r.receipt.url)) return 'unavailable';
    await this.workflow.useAccount(r.recipe);
    const browser = this.workflow.browser; await browser.open();
    const page = await browser.context!.newPage();
    try {
      await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' });
      const response = await page.goto(r.receipt.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const text = await page.locator('body').innerText({ timeout: 5000 });
      if (onAuthPage(page.url()) || await page.locator('input[type="password"]:visible').count()) {
        if (retried || !this.workflow.auth.vault.configured) return 'unavailable';
        await page.close(); await this.workflow.auth.ensureSignedIn(); return this.inspect(r, true);
      }
      if (!response || browser.isChallengePage(await page.title(), text.slice(0, 800))) return 'unavailable';
      // Redirects to home/login/search and 200 error shells are inconclusive, never evidence of deletion.
      if (page.url().split('?')[0].replace(/\/$/, '') !== r.receipt.url.split('?')[0].replace(/\/$/, '')) return 'unavailable';
      if ([404, 410].includes(response.status())) {
        // A real, independently loaded control must work before any 404/410 counts as evidence.
        const control = await browser.context!.newPage();
        try {
          const response = await control.goto('https://mymarket.ge/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
          const text = await control.locator('body').innerText({ timeout: 5000 });
          if (!response || response.status() !== 200 || !/^(www\.)?mymarket\.ge$/.test(new URL(control.url()).hostname) || onAuthPage(control.url()) || await control.locator('input[type="password"]:visible').count() || browser.isChallengePage(await control.title(), text.slice(0,800)) || !/mymarket|მაიმარკეტ/i.test((await control.title()) + text) || text.trim().length < 20 || !/search|categor|ძებნ|ძიება|კატეგორ/i.test(text)) return 'unavailable';
          return 'missing';
        } catch { return 'unavailable'; } finally { await control.close(); }
      }
      if (response.status() !== 200 || !text.includes(r.recipe.title) || !text.includes(r.recipe.price)) return 'unavailable';
      return 'active';
    } finally { await page.close(); }
  }
  async check(now = Date.now()) {
    const flow = this.workflow;
    if (flow.busy) return;
    if (flow.prepared && Date.now() - flow.prepared.at > 10 * 60_000) flow.prepared = undefined;
    if (flow.prepared) return;
    flow.busy = true;
    try {
      const records = this.archive.all().filter(r => !r.deleteRequestedAt && r.enabled && r.receipt && ['active', 'missing', 'unavailable'].includes(r.status) && r.nextCheckAt <= now);
      // Bound each queue pass; remaining due records run on the next minute tick.
      for (const r of records.slice(0, 5)) {
        const result = await this.probe(r).catch(() => 'unavailable' as const);
        r.checkedAt = now; r.nextCheckAt = now + CHECK_INTERVAL;
        if (result !== 'missing') {
          r.status = result; if (result === 'active') r.deletionNotified = false; r.missingCount = 0; delete r.firstMissingAt;
          r.message = result === 'active' ? 'Public listing verified.' : 'Check inconclusive (login, challenge, changed page or network). No re-listing attempted.';
        } else {
          r.status = 'missing'; r.missingCount++; r.firstMissingAt ??= now;
          r.nextCheckAt = now + MISSING_RECHECK;
          r.message = 'Public listing returned 404/410. Waiting for a separate confirmation before re-listing.';
          if (r.missingCount >= 2 && now - r.firstMissingAt! >= MISSING_RECHECK && !r.deletionNotified) {
            r.deletionNotified = true; this.workflow.telegram.notify(`Listing confirmed deleted by MyMarket: ${r.recipe.title}. ${r.receipt!.url}`);
          }
          if (r.missingCount >= 2 && (!flow.settings.load().automation.publish || !flow.settings.load().automation.autoRelist)) {
            r.nextCheckAt = now + CHECK_INTERVAL;
            r.message = 'Confirmed missing. Automatic re-listing is disabled in Settings.';
          }
        }
        this.archive.write(r);
        if (r.missingCount >= 2 && now - r.firstMissingAt! >= MISSING_RECHECK && flow.settings.load().automation.publish && flow.settings.load().automation.autoRelist) await this.relist(r);
      }
    } finally { flow.busy = false; }
  }
  async relist(r: ListingRecord) {
    const flow = this.workflow;
    const latest = this.archive.get(r.id);
    if (latest.deleteRequestedAt || latest.replacementId || !latest.enabled || !flow.settings.load().automation.publish || !flow.settings.load().automation.autoRelist) return;
    // Persist the one replacement ID before any browser action. Blocked/uncertain runs require human review.
    const d: Draft = { ...structuredClone(r.recipe), id: this.archive.store.create().id, revision: 0, state: 'review', events: [], relistOf: r.id };
    delete d.receipt; delete d.preparedAt; delete d.preparedRevision;
    r.replacementId = d.id; r.status = 'relisting'; r.message = 'Confirmed missing twice; preparing one replacement from the saved recipe.';
    this.archive.store.save(d); this.archive.write(r);
    try {
      await flow.useAccount(d);
      // A missing/corrupt photo must fail before preparation or submission.
      if (this.archive.store.fingerprint(d) !== r.fingerprint) throw new WorkflowError('PHOTO', 'The saved content or photos changed.');
      await flow.prepare(d);
      if (d.state !== 'ready') throw new WorkflowError('FORM', 'The current form requires review.');
      // Recheck on a separate tab after preparing so recovery/flapping cannot cause a duplicate.
      if (await this.probe(r) !== 'missing') throw new WorkflowError('RELIST', 'The old listing could not be confirmed missing immediately before replacement.');
      await flow.fixit(r.recipe.title + ' pre-submit', () => flow.publish(d), async () => {
        // Repair only preparation. publish catches every uncertain post-claim outcome itself, so this cannot retry a submit.
        await flow.prepareAI(d);
        if (d.state !== 'ready') throw new WorkflowError('UNCERTAIN', 'Fix-it could not confidently restore the form before submission.');
        this.archive.store.save(d);
        if (await this.probe(r) !== 'missing') throw new WorkflowError('RELIST', 'The old listing is no longer confirmed missing.');
        await flow.publish(d);
        if ((d as Draft).state !== 'published') throw new WorkflowError('UNCERTAIN', 'The single replacement submission could not be verified.');
      });
      if ((d as Draft).state !== 'published') throw new WorkflowError('RELIST', 'The replacement outcome needs review.');
      r.status = 'replaced'; r.message = 'Replacement verified; monitoring continues on its record.';
      flow.telegram.notify(`Re-list succeeded: ${r.recipe.title}. ${d.receipt!.url}`);
    } catch (e) {
      if (!['published', 'unknown'].includes(d.state)) d.state = 'blocked';
      r.status = 'attention'; r.message = e instanceof WorkflowError ? e.message + ' Automatic re-listing stopped; no automatic retry will run.' : 'Automatic re-listing stopped. Inspect the replacement draft and MyMarket account; no automatic retry will run.';
      flow.telegram.notify(`Attention: ${r.recipe.title}. ${r.message}`);
    } finally {
      if (['ready','published'].includes(d.state) && d.automation) r.recipe.automation = structuredClone(d.automation);
      flow.prepared = undefined; this.archive.store.save(d); this.archive.write(r);
    }
  }
}
