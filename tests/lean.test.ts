import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { Accounts } from '../server/accounts';
import { SettingsStore } from '../server/settings';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { createApp } from '../server/app';
import { savePhoto } from '../server/photos';
import { ListingMonitor, MISSING_RECHECK } from '../server/listings';
import { config } from '../server/config';

const headers = { 'Content-Type': 'application/json', 'X-Linko-Request': '1' };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'linko-lean-'));
  const settings = new SettingsStore(join(root, 'settings.json'));
  const store = new Store(join(root, 'workspace.sqlite'), join(root, 'listings'));
  const flow = new Workflow(store, undefined, new CredentialVault(join(root, 'account.json'), false), settings);
  const accountId = flow.accounts.add({ label: 'Studio', identifier: 'owner@x.io', password: randomUUID() });
  const instance = createApp(store, flow), server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  async function item(title: string) {
    const d = store.create(accountId), photo = await savePhoto(readFileSync('public/icons/icon-192.png'));
    Object.assign(d, { title, price: '25', description: 'Used studio lamp', photos: [photo], coverId: photo.id });
    store.save(d); return d;
  }
  const close = async () => { await new Promise<void>(r => server.close(() => r())); store.db.close(); rmSync(root, { recursive: true, force: true }); };
  return { ...instance, flow, settings, root, base, item, close };
}

test('My listings merges durable jobs and receipts without duplicate rows or private recipe data', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const queued = await f.item('Queued'), live = await f.item('Live');
    f.queue.enqueue(queued.id, 'submit');
    const job = f.queue.enqueue(live.id, 'submit');
    f.store.db.prepare("UPDATE jobs SET status='published' WHERE id=?").run(job.id);
    live.state = 'published'; live.receipt = { url: 'https://mymarket.ge/pr/900/lamp', at: new Date().toISOString(), evidence: 'Fixture receipt' };
    f.store.save(live); f.flow.archive.published(live);
    const get = async () => {
      const response = await fetch(f.base + '/listings'); assert.equal(response.headers.get('cache-control'), 'no-store');
      const data = await response.json(); return data.listings as import('../server/listing-summary').ListingSummary[];
    };
    let rows = await get(); assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.id === queued.id)?.status, 'queued');
    const row = rows.find(r => r.id === live.id)!;
    assert.equal(row.status, 'live'); assert.equal(row.price, '25'); assert.equal(row.currency, 'GEL'); assert.equal(row.account, 'Studio');
    assert.equal(row.url, live.receipt.url); assert.equal(row.canDelete, true); assert.equal('recipe' in row, false); assert.equal('fingerprint' in row, false);
    // History covers use the immutable recipe, even if the draft changes later.
    live.photos = []; live.coverId = ''; f.store.save(live);
    const cover = await fetch(new URL(row.cover!, f.base)); assert.equal(cover.status, 200);
    assert.equal(cover.headers.get('cache-control'), 'no-store'); assert.match(cover.headers.get('content-type')!, /image\/jpeg/);
    const r = f.flow.archive.get(live.id);
    for (const [internal, expected] of [['relisting', 'publishing'], ['replaced', 'relisted'], ['attention', 'failed'], ['missing', 'failed'], ['unavailable', 'failed'], ['deleted_by_owner', 'deleted-by-me']] as const) {
      r.status = internal; f.flow.archive.write(r); rows = await get();
      assert.equal(rows.find(row => row.id === live.id)?.status, expected);
    }
    f.flow.accounts.remove(live.accountId!);
    assert.equal((await get()).find(r => r.id === live.id)?.account, 'Studio');
    f.store.db.prepare("UPDATE jobs SET status='running' WHERE draft=?").run(queued.id);
    assert.equal((await get()).find(r => r.id === queued.id)?.status, 'publishing');
    f.store.db.prepare("UPDATE jobs SET status='failed' WHERE draft=?").run(queued.id);
    assert.equal((await get()).find(r => r.id === queued.id)?.status, 'failed');
    f.queue.enqueue(queued.id, 'submit'); assert.equal((await get()).filter(r => r.id === queued.id).length, 1);
    assert.equal((await get()).find(r => r.id === queued.id)?.status, 'queued');
  } finally { await f.close(); }
});

test('deleting a queued listing cancels it durably, never calls the browser or publishes after restart', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const d = await f.item('Cancel me'); f.queue.enqueue(d.id, 'submit');
    let runs = 0; f.flow.run = async () => { runs++; }; f.flow.deleteListing = async () => { throw new Error('No marketplace ad exists'); };
    const url = f.base + '/listings/' + d.id + '/delete';
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 409);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ confirm: true }) })).status, 200);
    const r = f.flow.archive.get(d.id); assert.equal(r.status, 'deleted_by_owner'); assert.ok(r.deleteRequestedAt); assert.equal(r.enabled, false);
    f.flow.archive.recover(); f.queue.recover(); await f.queue.drain(); assert.equal(runs, 0);
    assert.throws(() => f.queue.enqueue(d.id, 'submit'), /deleted by you/);
    assert.throws(() => f.flow.archive.pause(d.id, true), /permanently retired/);
    assert.equal((await fetch(f.base + '/drafts/' + d.id + '/publish', { method: 'POST', headers, body: JSON.stringify({ revision: d.revision }) })).status, 409);
    assert.equal((await (await fetch(f.base + '/drafts')).json()).drafts.some((v: { id: string }) => v.id === d.id), false);
    assert.equal((await (await fetch(f.base + '/listings')).json()).listings[0].status, 'deleted-by-me');
    const running = await f.item('In progress'); const job = f.queue.enqueue(running.id, 'submit');
    f.store.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
    assert.throws(() => f.queue.cancel(running.id), /already started/);
  } finally { await f.close(); }
});

test('automation toggles migrate from runtime defaults, persist independently, and gate queued jobs and background relisting', { timeout: 30_000 }, async () => {
  const f = await fixture(), before = [config.publish, config.autoRelist];
  try {
    config.publish = true; config.autoRelist = false;
    const old = f.settings.load(); const { automation, ...legacy } = old;
    writeFileSync(f.settings.file, JSON.stringify(legacy));
    assert.deepEqual(f.settings.load().automation, { publish: true, autoRelist: false });
    const put = (data: unknown, secure = true) => fetch(f.base + '/settings/automation', { method: 'PUT', headers: secure ? headers : { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await put({ publish: true, autoRelist: true }, false)).status, 403);
    assert.equal((await put({ publish: 'true', autoRelist: true })).status, 400);
    assert.equal((await put({ publish: false, autoRelist: true, extra: true })).status, 400);
    assert.equal((await put({ publish: false, autoRelist: true })).status, 200);
    config.publish = false; config.autoRelist = false;
    assert.deepEqual(new SettingsStore(f.settings.file).load().automation, { publish: false, autoRelist: true });
    assert.deepEqual(f.settings.load().ai, old.ai); assert.deepEqual(f.settings.load().telegram, old.telegram);
    const d = await f.item('Gated');
    assert.equal((await fetch(f.base + '/drafts/' + d.id + '/publish', { method: 'POST', headers, body: JSON.stringify({ revision: d.revision }) })).status, 409);
    let prepares = 0; f.flow.useAccount = async () => {}; f.flow.prepare = async () => { prepares++; };
    f.queue.enqueue(d.id, 'submit'); await f.queue.drain(); assert.equal(prepares, 0);
    assert.equal(f.queue.all()[0].status, 'failed');
    // Monitor still checks listings with both publishing gates disabled.
    d.state = 'published'; d.receipt = { url: 'https://mymarket.ge/pr/900/lamp', at: new Date().toISOString(), evidence: 'Fixture receipt' };
    f.store.save(d); f.flow.archive.published(d); const r = f.flow.archive.get(d.id); r.nextCheckAt = 0; f.flow.archive.write(r);
    let checks = 0; const monitor = new ListingMonitor(f.flow, f.flow.archive, async () => { checks++; return 'missing'; });
    const now = Date.now(); await monitor.check(now); await monitor.check(now + MISSING_RECHECK);
    assert.equal(checks, 2); assert.equal(prepares, 0); assert.equal(f.flow.archive.get(d.id).replacementId, undefined);
    await put({ publish: true, autoRelist: false });
    await monitor.relist(f.flow.archive.get(d.id)); assert.equal(prepares, 0);
    await put({ publish: true, autoRelist: true });
    f.flow.prepare = async draft => { prepares++; draft.state = 'blocked'; };
    await monitor.relist(f.flow.archive.get(d.id)); assert.equal(prepares, 1);
    assert.equal((await (await fetch(f.base + '/health')).json()).publishingEnabled, true);
    // Disabling while a job is queued is honored by its execution guard.
    const waiting = await f.item('Waiting'); f.queue.enqueue(waiting.id, 'submit'); await put({ publish: false, autoRelist: false });
    await f.queue.drain(); assert.equal(prepares, 1);
  } finally { [config.publish, config.autoRelist] = before; await f.close(); }
});

test('disabling publishing during a final audit prevents the irreversible claim and submit', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const settings = f.settings.load(); settings.automation = { publish: true, autoRelist: true }; f.settings.save(settings);
    const d = await f.item('Audit in progress'); d.state = 'ready'; d.preparedRevision = d.revision;
    const snapshot: import('../server/browser').Snapshot = { url: 'https://mymarket.ge/ka/pr-form/', title: 'Listing', text: 'Publish', images: [], elements: [{
      id: 'e1', tag: 'button', label: 'Publish', role: 'button', type: 'button', href: '', required: false, options: [], value: '', hasValue: false, checked: false, disabled: false,
    }] };
    f.flow.prepared = { id: d.id, revision: d.revision, hash: f.flow.formHash(snapshot), button: 'Publish', at: Date.now() };
    f.flow.browser.snapshot = async () => snapshot;
    f.flow.brain = async schema => {
      const data = f.settings.load(); data.automation.publish = false; f.settings.save(data);
      return schema.parse({ matches: true });
    };
    await assert.rejects(f.flow.publish(d), /disabled in Settings/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM attempts').get()!.count, 0);
    assert.equal(f.flow.archive.all().length, 0); assert.equal(d.state, 'ready');
    settings.automation = { publish: true, autoRelist: false }; f.settings.save(settings); d.relistOf = 'original';
    await assert.rejects(f.flow.publish(d), /disabled in Settings/);
  } finally { await f.close(); }
});

test('account city/phone defaults are private, isolated, migrated and used for each new draft', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const first = f.flow.accounts.defaultId;
    const second = f.flow.accounts.add({ label: 'Other', identifier: 'other@x.io', password: randomUUID() });
    const phone = '5' + randomInt(10_000_000, 99_999_999);
    const path = f.base + '/settings/accounts/' + first + '/defaults';
    assert.equal((await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'ბათუმი', phone }) })).status, 403);
    const put = await fetch(path, { method: 'PUT', headers, body: JSON.stringify({ location: 'ბათუმი', phone }) });
    assert.equal(put.status, 200); assert.equal(put.headers.get('cache-control'), 'no-store');
    const restored = new Accounts(f.flow.accounts.legacy, f.store);
    assert.deepEqual(restored.defaults(first), { location: 'ბათუმი', phone });
    assert.deepEqual(restored.defaults(second), { location: 'თბილისი', phone: '' });
    assert.equal(statSync(restored.file).mode & 0o777, 0o600);
    f.flow.accounts.use(first);
    const create = async () => (await (await fetch(f.base + '/drafts', { method: 'POST', headers, body: '{}' })).json());
    const d = await create(); assert.equal(d.location, 'ბათუმი'); assert.equal(d.accountId, first); assert.equal(JSON.stringify(d).includes(phone), false);
    const { id, photos, state, message, events, fields, questions, comparables, ...values } = d;
    assert.equal((await fetch(f.base + '/drafts/' + id, { method: 'PATCH', headers, body: JSON.stringify({ ...values, location: 'ქუთაისი' }) })).status, 200);
    assert.equal(f.store.get(id).location, 'ქუთაისი'); assert.equal((await create()).location, 'ბათუმი');
    // Pre-upgrade account documents acquire the city default without reading live data.
    const old = JSON.parse(readFileSync(restored.file, 'utf8')); delete old.accounts.find((a: { id: string }) => a.id === second).defaults;
    writeFileSync(restored.file, JSON.stringify(old));
    assert.deepEqual(new Accounts(f.flow.accounts.legacy, f.store).defaults(second), { location: 'თბილისი', phone: '' });
  } finally { await f.close(); }
});

test('existing needs_input drafts expose reasons and resume through PATCH and Publish without another category search', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const settings = f.settings.load(); settings.automation.publish = true; f.settings.save(settings);
    const d = await f.item('nikon D3400'); d.category = ['Cameras'];
    const job = f.queue.enqueue(d.id, 'submit');
    d.state = 'needs_input'; d.questions = [{ key: 'Power', label: 'Power source', options: ['Mains', 'Battery'] }];
    f.store.save(d); f.store.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
    const rows = async () => (await (await fetch(f.base + '/listings')).json()).listings;
    let row = (await rows()).find((r: { id: string }) => r.id === d.id);
    assert.equal(row.status, 'needs_input'); assert.equal(row.draftId, d.id); assert.match(row.reason, /Power source/);
    f.store.recover(); assert.equal(f.store.get(d.id).state, 'needs_input');
    const { id, photos, state, message, events, fields, questions, comparables, ...values } = d;
    const update = await fetch(f.base + '/drafts/' + id, { method: 'PATCH', headers, body: JSON.stringify({ ...values, facts: { Power: 'Battery' } }) });
    assert.equal(update.status, 200); const saved = await update.json();
    f.flow.useAccount = async () => {};
    f.flow.prepare = async draft => { assert.equal(draft.facts.Power, 'Battery'); draft.questions = []; draft.state = 'ready'; };
    let submitted = 0; f.flow.publish = async draft => { submitted++; draft.state = 'published'; };
    const publish = await fetch(f.base + '/drafts/' + id + '/publish', { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision }) });
    assert.equal(publish.status, 202); assert.equal((await publish.json()).nextDraft.location, 'თბილისი');
    await f.queue.drain(); assert.equal(submitted, 1);
    const failed = await f.item('Real failure'); const failedJob = f.queue.enqueue(failed.id, 'submit');
    failed.state = 'blocked'; f.store.event(failed, 'MyMarket did not accept the selected category.');
    f.store.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(failedJob.id);
    row = (await rows()).find((r: { id: string }) => r.id === failed.id);
    assert.equal(row.status, 'failed'); assert.match(row.reason, /did not accept/);
  } finally { await f.close(); }
});
