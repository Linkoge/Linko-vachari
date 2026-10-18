import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { createApp } from '../server/app';
import { PublishQueue } from '../server/queue';
import { savePhoto } from '../server/photos';
import { config } from '../server/config';
import type { Draft } from '../server/types';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'linko-drafts-'));
  const store = new Store(join(dir, 'workspace.sqlite'), join(dir, 'listings'));
  const workflow = new Workflow(store, undefined, new CredentialVault(join(dir, 'mymarket-account.json'), false));
  return { dir, ...createApp(store, workflow) };
}
const patch = (d: Draft, values = {}) => ({ accountId: d.accountId, revision: d.revision, title: d.title, description: d.description, price: d.price, currency: d.currency, model: d.model, condition: d.condition, location: d.location, category: d.category, facts: d.facts, coverId: d.coverId, photoOrder: d.photos.map(p => p.id), ...values });
async function item(store: Store, accountId = 'legacy') {
  const d = store.create(accountId), p = await savePhoto(readFileSync('public/icons/icon-192.png'));
  Object.assign(d, { title: 'Lamp', description: 'Used studio lamp with stand', price: '25', photos: [p], coverId: p.id, category: ['Lighting', 'Lamps'] }); store.save(d); return d;
}
test('independent autosaves while browser busy, revision conflicts, photos/order/cover resume, delete and persisted drafts', async () => {
  const f = fixture(), server = f.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const headers = { 'X-Linko-Request': '1', 'Content-Type': 'application/json' };
  try {
    const [a, b] = await Promise.all([item(f.store), item(f.store)]);
    f.workflow.busy = true;
    const updates = await Promise.all([a, b].map((d, i) => fetch(`${base}/drafts/${d.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch(d, { title: `Saved ${i}` })) })));
    assert.deepEqual(updates.map(r => r.status), [200, 200]);
    const stale = await fetch(`${base}/drafts/${a.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch(a, { title: 'Stale' })) });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'CONFLICT');
    let saved = f.store.get(a.id); assert.equal(saved.title, 'Saved 0'); assert.equal(f.store.get(b.id).title, 'Saved 1');
    const form = new FormData(); form.append('photos', new Blob([readFileSync('public/icons/icon-512.png')], { type: 'image/png' }), 'image.png');
    const uploaded = await fetch(`${base}/drafts/${a.id}/photos`, { method: 'POST', headers: { 'X-Linko-Request': '1', 'If-Match': String(saved.revision) }, body: form });
    assert.equal(uploaded.status, 200); saved = await uploaded.json() as Draft;
    const order = saved.photos.map(p => p.id).reverse();
    const reordered = await fetch(`${base}/drafts/${a.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch(saved, { photoOrder: order, coverId: order[0] })) });
    assert.equal(reordered.status, 200); saved = await reordered.json() as Draft;
    const resumed = await (await fetch(`${base}/drafts/${a.id}`)).json() as Draft;
    assert.deepEqual(resumed.photos.map(p => p.id), order); assert.equal(resumed.coverId, order[0]);
    const secondStore = new Store(join(f.dir, 'workspace.sqlite')); assert.equal(secondStore.get(a.id).title, 'Saved 0'); secondStore.db.close();
    assert.equal((await fetch(`${base}/drafts/${a.id}/photos/${order[0]}`, { method: 'DELETE', headers: { 'X-Linko-Request': '1', 'If-Match': '0' } })).status, 409);
    assert.equal((await fetch(`${base}/drafts/${a.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch(saved, { photoOrder: [order[0], order[0]] })) })).status, 409);
    const list = await (await fetch(base + '/drafts')).json() as any; assert.equal(list.drafts.length, 2);
    assert.equal((await fetch(`${base}/drafts/${a.id}?revision=0`, { method: 'DELETE', headers })).status, 409);
    assert.equal((await fetch(`${base}/drafts/${a.id}?revision=${saved.revision}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await fetch(`${base}/drafts/${a.id}`)).status, 404); assert.equal((await fetch(`${base}/drafts/${b.id}`)).status, 200);
  } finally { await new Promise<void>(r => server.close(() => r())); f.store.db.close(); }
});

test('Publish accepts immediately when browser busy, resets to a fresh draft, serializes accounts, keeps guards and reports status', async () => {
  const f = fixture(), previous = config.publish; config.publish = true;
  const server = f.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`, headers = { 'X-Linko-Request': '1', 'Content-Type': 'application/json' };
  try {
    f.workflow.accounts.add({ label: 'Personal', identifier: 'first@x.io', password: randomUUID() });
    const other = f.workflow.accounts.add({ label: 'Shop', identifier: 'owner@x.io', password: randomUUID() });
    const a = await item(f.store), b = await item(f.store), c = await item(f.store, other);
    f.workflow.busy = true;
    for (const d of [a, b, c]) {
      const response = await fetch(`${base}/drafts/${d.id}/publish`, { method: 'POST', headers, body: JSON.stringify({ revision: d.revision }) });
      assert.equal(response.status, 202); const data: any = await response.json();
      assert.notEqual(data.nextDraft.id, d.id); assert.equal(data.nextDraft.title, ''); assert.deepEqual(data.nextDraft.photos, []); assert.equal(data.nextDraft.accountId, d.accountId);
      assert.equal(f.store.get(d.id).state, 'queued');
    }
    assert.equal((await fetch(`${base}/drafts/${a.id}/publish`, { method: 'POST', headers, body: JSON.stringify({ revision: a.revision }) })).status, 409);
    assert.equal((await fetch(`${base}/drafts/${a.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch(a)) })).status, 409);
    assert.equal((await fetch(`${base}/drafts/${a.id}?revision=0`, { method: 'DELETE', headers })).status, 409);
    let active = 0, peak = 0; const order: string[] = [];
    f.workflow.useAccount = async () => {};
    f.workflow.prepare = async d => { active++; peak = Math.max(peak, active); order.push(d.id); await new Promise(r => setTimeout(r, 15)); d.state = 'ready'; };
    f.workflow.publish = async d => { try { const fp = f.store.claim(d); d.state = 'published'; d.receipt = { url: 'https://mymarket.ge/pr/900/lamp', at: new Date().toISOString(), evidence: 'Fixture receipt' }; f.store.finish(fp, 'published', d.receipt); } finally { active--; } };
    f.workflow.busy = false;
    await Promise.all([f.queue.drain(), f.queue.drain()]); await f.queue.drain(); await f.queue.drain();
    assert.equal(peak, 1); assert.deepEqual(order, [a.id, b.id, c.id]);
    assert.equal(f.store.get(a.id).state, 'published'); assert.equal(f.store.get(b.id).state, 'blocked'); assert.equal(f.store.get(c.id).state, 'published');
    const listings: any = await (await fetch(base + '/listings')).json(); assert.deepEqual(listings.listings.map((l: any) => l.status), ['live', 'failed', 'live']);
    config.publish = false; const disabled = await item(f.store);
    assert.equal((await fetch(`${base}/drafts/${disabled.id}/publish`, { method: 'POST', headers, body: JSON.stringify({ revision: disabled.revision }) })).status, 409);
    assert.equal(f.store.get(disabled.id).state, 'draft');
  } finally { config.publish = previous; await new Promise<void>(r => server.close(() => r())); f.store.db.close(); }
});

test('queue restart resumes untouched jobs, never retries interrupted submissions and notifies failures', async () => {
  const f = fixture(); const a = await item(f.store), b = await item(f.store), c = await item(f.store);
  const notices: string[] = []; f.workflow.telegram.notify = message => { notices.push(message); };
  try {
    const ja = f.queue.enqueue(a.id, 'submit'), jb = f.queue.enqueue(b.id, 'submit'); f.queue.enqueue(c.id, 'submit');
    f.store.db.prepare("UPDATE jobs SET status='running' WHERE id IN (?,?)").run(ja.id, jb.id);
    a.state = 'publishing'; f.store.save(a); f.store.claim(a); b.state = 'preparing'; f.store.save(b);
    f.store.recover(); const restarted = new PublishQueue(f.workflow); restarted.recover();
    assert.equal(f.store.get(a.id).state, 'unknown'); assert.equal(f.store.get(b.id).state, 'blocked'); assert.equal(f.store.get(c.id).state, 'queued');
    assert.deepEqual(restarted.all().map(j => j.status), ['unknown', 'failed', 'queued']); assert.equal(notices.length, 2);
    f.workflow.run = async () => { throw new Error('fixture failure'); };
    await restarted.drain(); assert.equal(restarted.all()[2].status, 'failed'); assert.equal(notices.length, 3);
    await restarted.drain(); assert.equal(notices.length, 3);
    assert.throws(() => f.store.claim(a), /already has/);
  } finally { f.store.db.close(); }
});

test('automatic required fact extraction accepts supplied evidence and leaves unknown requirements inline', async () => {
  const f = fixture(), d = await item(f.store);
  try {
    f.workflow.decide = async (_schema, instructions) => (instructions.startsWith('Compare only') ? { equivalent: true } : { answers: [{ key: 'Condition', value: 'Used', evidence: 'Used' }, { key: 'Power', value: 'Mains', evidence: 'Mains powered' }, { key: 'Size', value: '42', evidence: '' }] }) as any;
    const questions = [{ key: 'Condition', label: 'Condition', options: ['New', 'Used'] }, { key: 'Power', label: 'Power', options: ['Mains'] }, { key: 'Size', label: 'Size', options: [] }];
    assert.equal(await f.workflow.deriveRequired(d, questions), true); assert.deepEqual(d.facts, { Condition: 'Used' });
    assert.equal(await f.workflow.deriveRequired(d, questions), false);
    d.facts = {}; f.workflow.decide = async (_schema, instructions) => (instructions.startsWith('Compare only') ? { equivalent: false } : { answers: [{ key: 'Condition', value: 'New', evidence: 'Used' }] }) as any;
    assert.equal(await f.workflow.deriveRequired(d, questions), false); assert.deepEqual(d.facts, {});
  } finally { f.store.db.close(); }
});

test('concurrent photo uploads use revisions and cannot overwrite the gallery or text from another device', async () => {
  const f = fixture(), server = f.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const d = f.store.create('legacy'), base = `http://127.0.0.1:${(server.address() as any).port}/api/drafts/${d.id}`;
  const upload = () => { const form = new FormData(); form.append('photos', new Blob([readFileSync('public/icons/icon-512.png')], { type: 'image/png' }), 'photo.png'); return fetch(base + '/photos', { method: 'POST', headers: { 'X-Linko-Request': '1', 'If-Match': '0' }, body: form }); };
  try {
    const results = await Promise.all([upload(), upload()]); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    let saved = f.store.get(d.id); assert.equal(saved.photos.length, 1); assert.equal(saved.revision, 1);
    const form = new FormData(); form.append('photos', new Blob([readFileSync('public/icons/icon-192.png')], { type: 'image/png' }), 'photo.png');
    const outcomes = await Promise.all([
      fetch(base + '/photos', { method: 'POST', headers: { 'X-Linko-Request': '1', 'If-Match': '1' }, body: form }),
      fetch(base, { method: 'PATCH', headers: { 'X-Linko-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(patch(saved, { title: 'Other device' })) }),
    ]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]); saved = f.store.get(d.id);
    if (outcomes[1].status === 200) assert.equal(saved.title, 'Other device');
    else { assert.equal(saved.photos.length, 2); assert.equal(saved.title, ''); }
  } finally { await new Promise<void>(r => server.close(() => r())); f.store.db.close(); }
});

test('one Publish job discovers the category and prepares automatically, returning only missing facts for inline completion', async () => {
  const f = fixture(), previous = config.publish; config.publish = true;
  const d = await item(f.store), notices: string[] = []; d.category = []; f.store.save(d);
  f.workflow.telegram.notify = text => { notices.push(text); };
  f.workflow.useAccount = async () => {};
  let analyses = 0, preparations = 0, submissions = 0;
  f.workflow.analyze = async d => { analyses++; d.category = ['Lighting', 'Lamps']; d.state = 'review'; };
  f.workflow.prepare = async d => {
    preparations++;
    if (!d.facts.Power) { d.state = 'needs_input'; d.questions = [{ key: 'Power', label: 'Power source', options: ['Mains', 'Battery'] }]; }
    else { d.questions = []; d.state = 'ready'; }
  };
  f.workflow.publish = async d => { f.store.claim(d); submissions++; d.state = 'published'; };
  try {
    f.queue.enqueue(d.id, 'submit'); await f.queue.drain();
    assert.equal(analyses, 1); assert.equal(preparations, 1); assert.equal(submissions, 0);
    const needs = f.store.get(d.id); assert.equal(needs.state, 'needs_input'); assert.equal(needs.questions[0].label, 'Power source');
    assert.equal(f.queue.all()[0].status, 'needs_input'); assert.ok(notices.some(n => n.includes('more facts')));
    needs.facts.Power = 'Mains'; needs.revision++; f.store.save(needs);
    f.queue.enqueue(d.id, 'submit'); await f.queue.drain();
    assert.equal(analyses, 1); assert.equal(preparations, 2); assert.equal(submissions, 1); assert.equal(f.queue.all()[1].status, 'published');
  } finally { config.publish = previous; f.store.db.close(); }
});


test('requirements found by the final form check are derived before asking the owner', async () => {
  const f = fixture(), d = await item(f.store); let passes = 0;
  f.workflow.automatic = true;
  f.workflow.prepareWithCategory = async d => {
    passes++;
    if (!d.facts.Condition) { d.questions = [{ key: 'Condition', label: 'Condition', options: ['New', 'Used'] }]; d.state = 'needs_input'; }
    else { d.questions = []; d.state = 'ready'; }
  };
  d.specFields = [{ key: 'Condition', label: 'Condition', options: ['New', 'Used'], required: true, kind: 'owner' }];
  f.workflow.brain = (async (_schema, instructions) => instructions.startsWith('Compare only') ? { equivalent: true } : { description: '', answers: [{ key: 'Condition', value: 'Used', source: 'owner', evidence: 'Used', url: '' }] }) as typeof f.workflow.brain;
  try { await f.workflow.prepareAI(d); assert.equal(passes, 2); assert.equal(d.state, 'ready'); assert.deepEqual(d.facts, { Condition: 'Used' }); }
  finally { f.store.db.close(); }
});
