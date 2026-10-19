import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingsStore } from '../server/settings';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { createApp } from '../server/app';
import { savePhoto } from '../server/photos';

const headers = { 'Content-Type': 'application/json', 'X-Linko-Request': '1' };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'linko-queue-'));
  const settings = new SettingsStore(join(root, 'settings.json')), store = new Store(join(root, 'workspace.sqlite'), join(root, 'listings'));
  const flow = new Workflow(store, undefined, new CredentialVault(join(root, 'account.json'), false), settings);
  const accountId = flow.accounts.add({ label: 'Studio', identifier: 'owner@x.io', password: randomUUID() });
  const data = settings.load(); data.automation.publish = true; settings.save(data);
  const instance = createApp(store, flow), server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const photo = await savePhoto(readFileSync('public/icons/icon-192.png'));
  const item = (category: string[] = []) => {
    const d = Object.assign(store.create(accountId), { title: 'Nikon D3400', description: 'Used camera', price: '250', photos: [photo], coverId: photo.id, category });
    store.save(d); return d;
  };
  const post = (id: string, op: string, revision?: number) => fetch(`${base}/drafts/${id}/${op}`, { method: 'POST', headers, body: JSON.stringify({ revision: revision ?? store.get(id).revision }) });
  const jobs = () => instance.queue.all();
  const close = async () => { await new Promise<void>(r => server.close(() => r())); store.db.close(); rmSync(root, { recursive: true, force: true }); };
  return { ...instance, flow, settings, base, item, post, jobs, close };
}

test('Publish pressed while Find category is queued joins that job; repeated presses change nothing and nothing says already queued', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const d = f.item();
    const find = await f.post(d.id, 'analyze'); assert.equal(find.status, 202);
    const again = await f.post(d.id, 'analyze'); assert.equal(again.status, 202, 'a repeated Find category is accepted too');
    assert.equal(f.jobs().length, 1); assert.equal(f.jobs()[0].operation, 'analyze');
    const stale = f.store.get(d.id).revision - 1;
    const publish = await f.post(d.id, 'publish', stale); // even a stale revision cannot reject it
    assert.equal(publish.status, 202); const body = await publish.json();
    assert.equal(body.accepted, true); assert.ok(body.nextDraft); assert.equal(body.job.operation, 'submit');
    assert.equal(f.jobs().length, 1); assert.equal(f.jobs()[0].operation, 'submit'); assert.equal(f.jobs()[0].status, 'queued');
    for (let i = 0; i < 3; i++) {
      const duplicate = await f.post(d.id, 'publish'); assert.equal(duplicate.status, 202);
      const text = JSON.stringify(await duplicate.json()); assert.doesNotMatch(text, /already|queued job/i); assert.match(text, /"repeated":true/);
    }
    assert.equal(f.jobs().length, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM drafts').get()!.n, 2, 'duplicates do not create more drafts');
  } finally { await f.close(); }
});

test('Publish pressed during a running category job runs right after it, in the same job, and only once', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const d = f.item();
    assert.equal((await f.post(d.id, 'analyze')).status, 202);
    const calls: string[] = []; let during = 0;
    f.flow.run = async (id: string, operation: string) => {
      calls.push(operation); const draft = f.store.get(id);
      if (operation === 'analyze') {
        // The owner presses Publish (twice) while the category job is running.
        for (let i = 0; i < 2; i++) { const r = await f.post(id, 'publish', 0); assert.equal(r.status, 202); during++; }
        draft.category = ['Electronics', 'Cameras']; draft.state = 'review'; f.store.save(draft);
      } else { draft.state = 'published'; f.store.save(draft); }
    };
    await f.queue.drain();
    assert.equal(during, 2); assert.deepEqual(calls, ['analyze', 'submit']);
    assert.equal(f.jobs().length, 1); assert.equal(f.jobs()[0].status, 'published');
    assert.equal(f.queue.publishAfter(d.id), false);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM drafts').get()!.n, 2, 'one next draft, not one per press');
  } finally { await f.close(); }
});

test('an attached Publish does not run when the category job could not finish, and a plain Find category still ends there', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const stuck = f.item(), plain = f.item();
    await f.post(stuck.id, 'analyze'); await f.post(plain.id, 'analyze');
    const calls: string[] = [];
    f.flow.run = async (id: string, operation: string) => {
      calls.push(id === stuck.id ? operation + ':stuck' : operation + ':plain'); const draft = f.store.get(id);
      if (id === stuck.id) { await f.post(id, 'publish'); draft.state = 'blocked'; } else { draft.category = ['Cameras']; draft.state = 'review'; }
      f.store.save(draft);
    };
    await f.queue.drain(); await f.queue.drain();
    assert.deepEqual(calls, ['analyze:stuck', 'analyze:plain']);
    assert.deepEqual(f.jobs().map(j => j.status), ['failed', 'review']);
  } finally { await f.close(); }
});

test('Publish while the draft is already publishing is idempotent, and disabled publishing keeps its own clear reason', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const d = f.item(['Cameras']);
    assert.equal((await f.post(d.id, 'publish')).status, 202);
    f.store.db.prepare("UPDATE jobs SET status='running'").run(); const draft = f.store.get(d.id); draft.state = 'publishing'; f.store.save(draft);
    const repeat = await f.post(d.id, 'publish', 99); assert.equal(repeat.status, 202); assert.equal((await repeat.json()).repeated, true);
    assert.equal(f.jobs().length, 1);
    const data = f.settings.load(); data.automation.publish = false; f.settings.save(data);
    const off = await f.post(d.id, 'publish'); assert.equal(off.status, 409); assert.match((await off.json()).message, /disabled in Settings/);
  } finally { await f.close(); }
});

test('My listings shows every active job with its current step, including a category job that Publish has joined', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const a = f.item(), b = f.item(['Cameras']);
    await f.post(a.id, 'analyze'); await f.post(b.id, 'publish');
    const rows = async () => (await (await fetch(`${f.base}/listings`)).json()).listings as { id: string; status: string; progress?: string }[];
    assert.equal((await rows()).find(r => r.id === b.id)!.status, 'queued');
    assert.equal((await rows()).find(r => r.id === a.id)!.status, 'preparing');
    f.store.db.prepare("UPDATE jobs SET status='running'").run();
    for (const [draft, step] of [[a, 'Reading fields…'], [b, 'Filling form…']] as const) { const x = f.store.get(draft.id); x.step = step; x.state = 'preparing'; f.store.save(x); }
    assert.deepEqual((await rows()).filter(r => [a.id, b.id].includes(r.id)).map(r => [r.status, r.progress]).sort(), [['preparing', 'Reading fields…'], ['publishing', 'Filling form…']]);
    // Publish joined a running category job: the row already reads as publishing with the category job's step.
    f.store.db.prepare('INSERT INTO publish_after VALUES (?)').run(a.id);
    const x = f.store.get(a.id); x.step = 'Looking up specs…'; f.store.save(x);
    assert.deepEqual((await rows()).filter(r => r.id === a.id).map(r => [r.status, r.progress]), [['publishing', 'Looking up specs…']]);
  } finally { await f.close(); }
});

test('the step label is cleared when a job ends so it never lingers', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const d = f.item(['Cameras']);
    await f.post(d.id, 'analyze'); assert.equal(f.store.get(d.id).step, undefined);
    f.flow.useAccount = async () => {}; f.flow.accounts.use = () => {};
    f.flow.analyze = async draft => { f.flow.progress(draft, 'Finding category…'); assert.equal(f.store.get(d.id).step, 'Finding category…'); draft.category = ['Cameras']; };
    f.flow.initializeDetails = async draft => { f.flow.progress(draft, 'Reading fields…'); draft.state = 'review'; };
    await f.queue.drain();
    assert.equal(f.store.get(d.id).step, undefined);
  } finally { await f.close(); }
});
