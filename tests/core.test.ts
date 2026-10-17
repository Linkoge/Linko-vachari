import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from '../server/store';
import { savePhoto } from '../server/photos';
import { privateDir } from '../server/config';
import { createApp } from '../server/app';
import { guardClick, publishLabel } from '../server/policy';
import { allowedUrl, isListingUrl, redact, ElementInfo } from '../server/browser';
const control = (label: string, extras: Partial<ElementInfo> = {}): ElementInfo => ({ id: 'e1', tag: 'button', label, role: '', type: 'button', href: '', required: false, options: [], value: '', hasValue: false, checked: false, disabled: false, ...extras });
test('draft revisions, duplicate claims across draft IDs, crash recovery and receipt persistence', async () => {
  const s = new Store(':memory:'); const d = s.create();
  const p = await savePhoto(readFileSync('public/icons/icon-512.png')); Object.assign(d, { title: 'Lamp', description: 'Actual user facts', price: '12.00', photos: [p], coverId: p.id, state: 'ready' }); s.save(d);
  const fp = s.claim(d); assert.throws(() => s.claim({ ...d, id: 'another-draft', price: '12' }), /already has/);
  d.state = 'publishing'; s.save(d); s.recover(); assert.equal(s.get(d.id).state, 'unknown');
  assert.throws(() => s.claim(d), /already has/);
  const receipt = { url: 'https://mymarket.ge/pr/123/lamp', at: new Date().toISOString(), evidence: 'fixture verified' }; s.finish(fp, 'published', receipt);
  const row = s.db.prepare('SELECT state,receipt FROM attempts').get() as { state: string; receipt: string };
  assert.equal(row.state, 'published'); assert.deepEqual(JSON.parse(row.receipt), receipt); s.db.close();
});
test('actual image validation rejects videos and disguised files; normalizes photos without analysis', async () => {
  await assert.rejects(savePhoto(Buffer.from('not-an-image')), /JPEG/);
  const p = await savePhoto(readFileSync('public/icons/icon-512.png')); assert.equal(p.width, 512); assert.equal('score' in p, false);
  assert.equal(readFileSync(join(privateDir, 'photos', p.id + '.jpg')).subarray(0, 2).toString('hex'), 'ffd8');
});
test('PWA manifest points to real PNG icons at installable sizes', async () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some((i: any) => i.purpose === 'maskable'));
  for (const icon of manifest.icons) { const metadata = await sharp('public' + icon.src).metadata(); assert.equal(metadata.format, 'png'); assert.equal(`${metadata.width}x${metadata.height}`, icon.sizes); }
});
test('navigation policy stops publishing, generic submits, account changes, outsider URLs and secrets', () => {
  for (const name of ['Publish', 'გამოქვეყნება', 'Delete', 'Buy now', 'Save listing', 'Sign out', 'Settings', 'Submit']) assert.throws(() => guardClick(control(name), 'prepare', [], []));
  guardClick(control('Next'), 'prepare', [], []);
  guardClick(control('Lighting'), 'prepare', ['Lighting'], []);
  assert.equal(publishLabel.test('გამოქვეყნება'), true); assert.equal(publishLabel.test('Submit'), false);
  assert.equal(allowedUrl('https://mymarket.ge.evil.test/pr/123'), false); assert.equal(allowedUrl('javascript:alert(1)'), false); assert.equal(allowedUrl('http://mymarket.ge/'), false);
  assert.equal(allowedUrl('https://mymarket.ge/pr/123'), true);
  assert.equal(isListingUrl('https://mymarket.ge/product/meoradi/teqnika/potokamera/canon-eos-rebel-32482302/'), true);
  assert.equal(isListingUrl('https://www.mymarket.ge/ka/pr/27812687/teqnika/photo/canon/'), true);
  assert.equal(isListingUrl('https://mymarket.ge/products/teqnika/poto/potokamera/'), false);
  assert.equal(redact('contact sample@example.invalid'), 'contact [private email]');
});
test('API cross-origin protection, optimistic revision conflicts, private photo access and publish confirmation', async () => {
  const store = new Store(':memory:'); const { app } = createApp(store); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.on('listening', r)); const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api`; const headers = { 'Content-Type': 'application/json', 'X-Linko-Request': '1' };
  try {
    assert.equal((await fetch(url + '/drafts', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url + '/drafts', { method: 'POST', body: '{}' })).status, 403);
    const created = await fetch(url + '/drafts', { method: 'POST', headers, body: '{}' }); assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store'); const d = await created.json();
    const patch = { revision: 0, title: 'Lamp', description: 'Known facts', price: '12', currency: 'GEL', model: '', condition: '', location: '', category: [], facts: {}, coverId: '' };
    assert.equal((await fetch(url + '/drafts/' + d.id, { method: 'PATCH', headers, body: JSON.stringify(patch) })).status, 200);
    assert.equal((await fetch(url + '/drafts/' + d.id, { method: 'PATCH', headers, body: JSON.stringify(patch) })).status, 409);
    assert.equal((await fetch(url + `/drafts/${d.id}/photos/../../.env`)).status, 404);
    assert.equal((await fetch(url + `/drafts/${d.id}/publish`, { method: 'POST', headers, body: JSON.stringify({ revision: 1 }) })).status, 409);
    const saved = store.get(d.id); saved.state = 'unknown'; store.save(saved);
    assert.equal((await fetch(url + '/drafts/' + d.id, { method: 'PATCH', headers, body: JSON.stringify({ ...patch, revision: 1 }) })).status, 409);
  } finally { server.close(); store.db.close(); }
});
