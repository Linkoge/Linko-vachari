import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { ListingMonitor, CHECK_INTERVAL, MISSING_RECHECK, listingMarkdown, Availability } from '../server/listings';
import { config } from '../server/config';
import { createApp } from '../server/app';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'linko-records-'));
  const store = new Store(join(root, 'workspace.sqlite'), join(root, 'listings'));
  const flow = new Workflow(store);
  const d = store.create();
  Object.assign(d, { title: 'Studio lamp', description: 'Exact text\nWith `markup` and ქართული.', price: '125.00', category: ['Home', 'Lighting', 'Studio lamps'], facts: { Power: 'Mains' }, fields: [{ label: 'Power source', value: 'Mains', source: 'facts.Power' }], state: 'ready' });
  store.save(d); flow.archive.snapshot(d);
  const fp = store.claim(d);
  d.state = 'published'; d.receipt = { url: 'https://mymarket.ge/pr/900/lamp', at: new Date().toISOString(), evidence: 'Fixture confirmation' };
  store.finish(fp, 'published', d.receipt); store.save(d); flow.archive.published(d);
  const r = flow.archive.get(d.id); r.nextCheckAt = 0; flow.archive.write(r);
  const cleanup = () => { store.db.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, store, flow, d, cleanup };
}

test('Markdown and durable recipe retain exact section, text, price, fields and ordered photos', () => {
  const f = fixture();
  try {
    const r = f.flow.archive.get(f.d.id);
    // Photo links must follow upload order, with the cover first, regardless of input ordering.
    r.recipe.photos = [{ id: 'first', width: 1, height: 1 }, { id: 'cover', width: 1, height: 1 }]; r.recipe.coverId = 'cover';
    f.flow.archive.write(r);
    const file = join(f.root, 'listings', r.id + '.md'), md = readFileSync(file, 'utf8');
    assert.ok(md.includes(JSON.stringify(f.d.category))); assert.ok(md.includes('125.00'));
    assert.ok(md.includes(JSON.stringify(f.d.description).replace(/`/g, '\\u0060')));
    assert.ok(md.includes('Power source')); assert.ok(md.indexOf('cover.jpg') < md.indexOf('first.jpg'));
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(join(f.root, 'listings')).mode & 0o777, 0o700);
    f.d.description = 'Later mutation'; assert.notEqual(f.flow.archive.get(r.id).recipe.description, f.d.description);
    assert.equal(listingMarkdown(r), md);
  } finally { f.cleanup(); }
});

test('confirmed deletion produces one replacement; duplicate claims and repeat checks cannot resubmit', async () => {
  const f = fixture(); const previous = [config.publish, config.autoRelist];
  config.publish = true; config.autoRelist = true; let submits = 0;
  f.flow.prepare = async d => { d.state = 'ready'; };
  f.flow.publish = async d => {
    const fp = f.store.claim(d); submits++;
    d.receipt = { url: 'https://mymarket.ge/pr/901/lamp', at: new Date().toISOString(), evidence: 'Replacement fixture' }; d.state = 'published';
    f.store.finish(fp, 'published', d.receipt); f.store.save(d); f.flow.archive.published(d);
  };
  const monitor = new ListingMonitor(f.flow, f.flow.archive, async () => 'missing');
  try {
    const now = Date.now();
    await monitor.check(now); assert.equal(submits, 0); assert.equal(f.flow.archive.get(f.d.id).missingCount, 1);
    await monitor.check(now + MISSING_RECHECK - 1); assert.equal(submits, 0);
    await monitor.check(now + MISSING_RECHECK); assert.equal(submits, 1);
    const r = f.flow.archive.get(f.d.id); assert.equal(r.status, 'replaced');
    const replacement = f.store.get(r.replacementId!);
    assert.equal(replacement.description, f.d.description); assert.deepEqual(replacement.facts, f.d.facts); assert.deepEqual(replacement.category, f.d.category);
    assert.throws(() => f.store.claim(replacement)); assert.throws(() => f.store.claim({ ...replacement, relistOf: undefined }));
    assert.equal(f.flow.archive.get(replacement.id).status, 'active');
    await monitor.check(now + MISSING_RECHECK + 1); assert.equal(submits, 1);
  } finally { [config.publish, config.autoRelist] = previous; f.cleanup(); }
});

test('network/challenge uncertainty resets deletion evidence; pause and publish gates prevent re-listing', async () => {
  const f = fixture(); const previous = [config.publish, config.autoRelist];
  let result: Availability = 'missing', prepares = 0, probes = 0;
  f.flow.prepare = async () => { prepares++; };
  const monitor = new ListingMonitor(f.flow, f.flow.archive, async () => { probes++; return result; });
  try {
    config.publish = false; config.autoRelist = true;
    const now = Date.now(); await monitor.check(now); result = 'unavailable';
    await monitor.check(now + MISSING_RECHECK); assert.equal(f.flow.archive.get(f.d.id).missingCount, 0);
    assert.equal(f.flow.archive.get(f.d.id).nextCheckAt, now + MISSING_RECHECK + CHECK_INTERVAL);
    result = 'missing'; await monitor.check(now + CHECK_INTERVAL * 2); await monitor.check(now + CHECK_INTERVAL * 2 + MISSING_RECHECK);
    assert.equal(prepares, 0); config.publish = true; config.autoRelist = false;
    await monitor.check(now + CHECK_INTERVAL * 3); assert.equal(prepares, 0);
    config.autoRelist = true; f.flow.archive.pause(f.d.id, false); const count = probes;
    await monitor.check(now + CHECK_INTERVAL * 4); assert.equal(probes, count);
    f.flow.archive.pause(f.d.id, true); assert.equal(f.flow.archive.get(f.d.id).missingCount, 0);
    f.flow.manualActive = true; await monitor.check(now + CHECK_INTERVAL * 5); assert.equal(probes, count);
    f.flow.manualActive = false; f.flow.prepared = { id: f.d.id, revision: 0, hash: '', button: '', at: Date.now() };
    await monitor.check(now + CHECK_INTERVAL * 5); assert.equal(probes, count);
  } finally { [config.publish, config.autoRelist] = previous; f.cleanup(); }
});

test('uncertain replacement and process interruption stay locked after restart', async () => {
  const f = fixture(); const previous = [config.publish, config.autoRelist]; config.publish = true; config.autoRelist = true;
  f.flow.prepare = async d => { d.state = 'ready'; };
  let submits = 0;
  f.flow.publish = async d => { const fp = f.store.claim(d); submits++; d.state = 'unknown'; f.store.finish(fp, 'unknown'); };
  const monitor = new ListingMonitor(f.flow, f.flow.archive, async () => 'missing');
  try {
    const now = Date.now(); await monitor.check(now); await monitor.check(now + MISSING_RECHECK);
    const r = f.flow.archive.get(f.d.id); assert.equal(r.status, 'attention'); assert.equal(submits, 1);
    assert.equal(f.store.get(r.replacementId!).state, 'unknown');
    r.status = 'relisting'; f.flow.archive.write(r); f.store.recover(); f.flow.archive.recover();
    assert.equal(f.flow.archive.get(r.id).status, 'attention');
    await monitor.check(now + CHECK_INTERVAL); assert.equal(submits, 1);
    assert.throws(() => f.store.claim(f.store.get(r.replacementId!)));
  } finally { [config.publish, config.autoRelist] = previous; f.cleanup(); }
});

test('reappearance immediately before submit stops replacement without a publishing claim', async () => {
  const f = fixture(); const previous = [config.publish, config.autoRelist]; config.publish = true; config.autoRelist = true;
  let checks = 0, submits = 0;
  f.flow.prepare = async d => { d.state = 'ready'; }; f.flow.publish = async () => { submits++; };
  const monitor = new ListingMonitor(f.flow, f.flow.archive, async () => ++checks < 3 ? 'missing' : 'active');
  try {
    const now = Date.now(); await monitor.check(now); await monitor.check(now + MISSING_RECHECK);
    assert.equal(submits, 0); assert.equal(f.flow.archive.get(f.d.id).status, 'attention');
  } finally { [config.publish, config.autoRelist] = previous; f.cleanup(); }
});

test('in-flight checks serialize browser use and preparation failures never get an automatic retry', async () => {
  const f = fixture(); const previous = [config.publish, config.autoRelist]; config.publish = true; config.autoRelist = true;
  let release!: (value: Availability) => void, probes = 0, prepares = 0;
  const monitor = new ListingMonitor(f.flow, f.flow.archive, async () => { probes++; return new Promise(resolve => { release = resolve; }); });
  try {
    const now = Date.now(), pending = monitor.check(now);
    assert.equal(f.flow.busy, true); await monitor.check(now); assert.equal(probes, 1);
    release('missing'); await pending; assert.equal(f.flow.busy, false);
    monitor.probe = async () => 'missing'; f.flow.prepare = async () => { prepares++; throw new Error('Form changed'); };
    await monitor.check(now + MISSING_RECHECK); assert.equal(prepares, 1);
    const r = f.flow.archive.get(f.d.id); assert.equal(r.status, 'attention');
    assert.equal(f.store.get(r.replacementId!).state, 'blocked');
    await monitor.check(now + CHECK_INTERVAL); assert.equal(prepares, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.n, 1);
  } finally { [config.publish, config.autoRelist] = previous; f.cleanup(); }
});

test('records refresh before any submit claim, retain referenced photos and recover legacy missing photos safely', () => {
  const f = fixture();
  try {
    const d = f.store.create(); Object.assign(d, { title: 'Draft lamp', description: 'Original text', price: '20', state: 'ready' });
    f.flow.archive.snapshot(d); d.description = 'Reviewed final text'; f.flow.archive.snapshot(d);
    assert.equal(f.flow.archive.get(d.id).recipe.description, 'Reviewed final text');
    const r = f.flow.archive.get(d.id); r.recipe.photos = [{ id: 'retained', width: 1, height: 1 }]; f.flow.archive.write(r);
    assert.equal(f.store.photoReferenced('retained'), true); assert.equal(f.store.photoReferenced('absent'), false);
    const legacy = f.store.create(); legacy.state = 'published'; legacy.receipt = f.d.receipt; legacy.photos = [{ id: 'missing', width: 1, height: 1 }]; f.store.save(legacy);
    f.flow.archive.recover(); assert.equal(f.flow.archive.get(legacy.id).status, 'attention');
    assert.equal(f.flow.archive.get(legacy.id).receipt?.url, legacy.receipt?.url);
    const reopened = new Store(join(f.root, 'workspace.sqlite'), join(f.root, 'listings'));
    try { assert.equal(new Workflow(reopened).archive.get(legacy.id).status, 'attention'); } finally { reopened.db.close(); }
  } finally { f.cleanup(); }
});

test('real browser distinguishes 404/410 from outages, challenges, login and redirects', { timeout: 60_000 }, async () => {
  const f = fixture(), browser = await chromium.launch(); const context = await browser.newContext();
  f.flow.browser.context = context; f.flow.browser.page = await context.newPage();
  const monitor = new ListingMonitor(f.flow); let status = 200, body = '<h1>Studio lamp</h1><p>125.00 GEL</p>', redirect = false;
  await context.route('https://mymarket.ge/**', route => route.fulfill({ status, contentType: 'text/html', body: redirect ? '<script>location.replace("/")</script>' : body }));
  try {
    const r = f.flow.archive.get(f.d.id);
    assert.equal(await monitor.inspect(r), 'active');
    for (const code of [404, 410]) { status = code; body = 'Gone'; assert.equal(await monitor.inspect(r), 'missing'); }
    status = 503; assert.equal(await monitor.inspect(r), 'unavailable');
    status = 200; body = 'Listing unavailable'; assert.equal(await monitor.inspect(r), 'unavailable');
    status = 404; body = '<title>Just a moment...</title>Checking your browser'; assert.equal(await monitor.inspect(r), 'unavailable');
    body = '<label>Password<input type="password"></label>'; assert.equal(await monitor.inspect(r), 'unavailable');
    // A real redirect, rather than a script whose navigation may still be pending.
    await context.unroute('https://mymarket.ge/**');
    await context.route('https://mymarket.ge/**', route => route.request().url().includes('/pr/') ? route.fulfill({ status: 302, headers: { location: 'https://mymarket.ge/' } }) : route.fulfill({ status: 404, body: 'Home' }));
    assert.equal(await monitor.inspect(r), 'unavailable');
    assert.equal(context.pages().length, 1);
  } finally { await browser.close(); f.cleanup(); }
});

test('records and pause API keep archive behind the existing private access boundary', async () => {
  const f = fixture(); const { app } = createApp(f.store, f.flow); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/listings`;
  try {
    const response = await fetch(base); assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data.records[0].title, f.d.title); assert.equal('recipe' in data.records[0], false);
    const md = await fetch(base + '/' + f.d.id + '/record'); assert.equal(md.status, 200); assert.match(md.headers.get('content-disposition')!, /attachment/); assert.ok((await md.text()).includes('Power source'));
    assert.equal((await fetch(base + '/' + f.d.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' })).status, 403);
    assert.equal((await fetch(base + '/' + f.d.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: '{"enabled":false}' })).status, 200);
    assert.equal(f.flow.archive.get(f.d.id).enabled, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
});
