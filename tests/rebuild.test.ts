import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { CategoryTree, TREE_MAX_AGE, crawlCategories, categoryId, categoriesFromResponse } from '../server/categories';
import { MarketplaceBrowser } from '../server/browser';
import { config, privateDir } from '../server/config';
import { createApp } from '../server/app';
import { WorkflowError } from '../server/types';
import { ask } from '../server/codex';
import { ListingMonitor } from '../server/listings';

function fixture(brain: typeof ask = async () => { throw new Error('unexpected AI'); }) {
  const dir = mkdtempSync(join(tmpdir(), 'linko-rebuild-'));
  const store = new Store(join(dir, 'workspace.sqlite'), join(dir, 'listings'));
  const vault = new CredentialVault(join(dir, 'mymarket-account.json'), false);
  return { dir, store, vault, flow: () => new Workflow(store, brain, vault), close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const creds = () => ({ identifier: 'owner@x.io', password: randomUUID() });
const categories = [
  { id: '1', path: ['Lighting', 'Studio lamps'], url: 'https://mymarket.ge/c/1/lamps' },
  { id: '2', path: ['Lighting', 'Bulbs'], url: 'https://mymarket.ge/c/2/bulbs' },
  { id: '3', path: ['Furniture', 'Tables'], url: 'https://mymarket.ge/c/3/tables' },
];

test('single account migration is durable, preserves the legacy profile and submit claims, and removes credentials without resurrection', () => {
  const f = fixture(), original = creds(); f.vault.save(original);
  const d = f.store.create(); d.title = 'Lamp'; f.store.save(d); const fingerprint = f.store.claim(d);
  f.store.db.prepare('INSERT INTO listing_records VALUES (?,?)').run(d.id, JSON.stringify({ id: d.id, recipe: d, status: 'active', receipt: { url: 'https://mymarket.ge/pr/1/lamp' } }));
  try {
    const flow = f.flow();
    assert.equal(f.store.get(d.id).accountId, 'legacy'); assert.equal(flow.archive.get(d.id).recipe.accountId, 'legacy');
    assert.deepEqual(flow.auth.vault.get(), original);
    assert.equal(flow.browser.profilePath(), join(privateDir, 'browser'));
    assert.equal(flow.accounts.view()[0].activeListings, 1);
    assert.equal(f.store.fingerprint(f.store.get(d.id)), fingerprint);
    assert.throws(() => f.store.claim(f.store.get(d.id)), /already has/);
    assert.equal(statSync(flow.accounts.file).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(flow.accounts.view()).includes(original.password));
    const restarted = f.flow(); assert.deepEqual(restarted.auth.vault.get(), original);
    restarted.accounts.remove('legacy');
    assert.equal(f.flow().accounts.view().length, 0);
    assert.throws(() => restarted.accounts.require('legacy'), /removed/);
  } finally { f.close(); }
});

test('account quotas count each active receipt once, retain paused/inconclusive listings, and separate accounts', () => {
  const f = fixture(); f.vault.save(creds()); const flow = f.flow();
  try {
    const second = flow.accounts.add({ ...creds(), label: 'Shop two' });
    for (const [i, status] of ['active', 'unavailable', 'missing', 'deleted_by_owner', 'replaced', 'unverified', 'attention'].entries()) {
      const d = f.store.create('legacy');
      f.store.db.prepare('INSERT INTO listing_records VALUES (?,?)').run(d.id, JSON.stringify({ id: d.id, recipe: d, status, enabled: false, ...(status === 'unverified' ? {} : { receipt: { url: `https://mymarket.ge/pr/${i + 1}/lamp` } }) }));
    }
    const d = f.store.create(second);
    f.store.db.prepare('INSERT INTO listing_records VALUES (?,?)').run(d.id, JSON.stringify({ id: d.id, recipe: d, status: 'active', receipt: { url: 'https://mymarket.ge/pr/99/lamp' } }));
    assert.deepEqual(flow.accounts.view().map(a => a.activeListings), [3, 1]);
    assert.notEqual(f.store.fingerprint({ ...d, accountId: 'legacy' }), f.store.fingerprint(d));
    assert.equal(flow.accounts.defaultId, second); assert.equal(f.flow().accounts.defaultId, second);
    flow.accounts.remove(second); assert.throws(() => flow.accounts.require(second), /removed/);
  } finally { f.close(); }
});

test('persistent browser profiles never share cookies and switching closes the prior context', { timeout: 60_000 }, async () => {
  const browser = new MarketplaceBrowser(), old = config.headless; config.headless = true;
  const first = randomUUID(), second = randomUUID();
  try {
    await browser.useAccount(first); await browser.open(); const oldContext = browser.context!;
    await oldContext.addCookies([{ name: 'owner', value: 'one', domain: 'mymarket.ge', path: '/', expires: Date.now() / 1000 + 3600 }]);
    await browser.useAccount(second); await browser.open();
    assert.equal(oldContext.pages().length, 0);
    assert.equal((await browser.context!.cookies()).some(c => c.name === 'owner'), false);
    await browser.context!.addCookies([{ name: 'owner', value: 'two', domain: 'mymarket.ge', path: '/', expires: Date.now() / 1000 + 3600 }]);
    await browser.useAccount(first); await browser.open();
    assert.equal((await browser.context!.cookies()).find(c => c.name === 'owner')?.value, 'one');
    await assert.rejects(browser.useAccount('../other'), /Invalid/);
  } finally { await browser.close(); config.headless = old; for (const id of [first, second]) rmSync(join(privateDir, 'browsers', id), { recursive: true, force: true }); }
});

test('account API chooses last-used by default, keeps credentials write-only and rejects edits while a job owns the browser', async () => {
  const f = fixture(), flow = f.flow(), { app } = createApp(f.store, flow); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const first = creds(), second = creds();
    await call('/settings/accounts', 'POST', { ...first, label: 'Personal' });
    const response = await call('/settings/accounts', 'POST', { ...second, label: 'Shop' }), raw = await response.text();
    assert.equal(response.status, 200); assert.ok(!raw.includes(first.password) && !raw.includes(second.password) && !raw.includes(second.identifier));
    const accounts = JSON.parse(raw).accounts, id = accounts[1].id;
    assert.equal((await (await call('/drafts', 'POST', {})).json()).accountId, id);
    const candidateDraft = f.store.create(id); candidateDraft.categoryCandidates = categories.map(c => c.path); f.store.save(candidateDraft);
    assert.equal((await call('/drafts/' + candidateDraft.id, 'PATCH', { ...candidateDraft, category: ['Invented'] })).status, 409);
    assert.equal((await call('/drafts/' + candidateDraft.id, 'PATCH', { ...candidateDraft, accountId: '' })).status, 400);
    const picked = await call('/drafts/' + candidateDraft.id, 'PATCH', { ...candidateDraft, category: categories[0].path });
    assert.equal(picked.status, 200); assert.equal((await picked.json()).categoryMethod, 'tree');
    flow.busy = true;
    assert.equal((await call('/settings/accounts/' + id, 'DELETE')).status, 409);
    assert.equal((await call('/settings/accounts', 'POST', { ...creds(), label: 'Blocked' })).status, 409);
    flow.busy = false;
    assert.equal((await call('/browser/start', 'POST', {})).status, 404);
    assert.equal((await (await call('/health')).json()).manualBrowserActive, undefined);
    await call('/settings/accounts/' + id, 'DELETE');
    await assert.rejects(flow.useAccount({ accountId: id }), /removed/);
    assert.equal((await call('/agent')).status, 200);
  } finally { server.close(); f.close(); }
});

test('semantic category crawler collects complete nested paths/IDs and atomically retains the old tree on failure', async () => {
  const real = await chromium.launch(), page = await real.newPage(), browser = new MarketplaceBrowser(); browser.page = page;
  const f = fixture(); const visited: string[] = [];
  try {
    await page.route('https://mymarket.ge/**', route => {
      const path = new URL(route.request().url()).pathname; visited.push(path);
      const body = path === '/' ? '<button onclick="document.querySelector(\'nav\').hidden=false">Categories</button><nav aria-label="Categories" hidden><ul><li><a href="/c/10/light">Lighting</a><ul><li><a href="/c/11/studio">Studio</a></li></ul></li></ul></nav>' : path.startsWith('/c/11') ? '<main><a href="/c/12/lamps">Lamps</a></main>' : '<main>No more categories</main>';
      return route.fulfill({ contentType: 'text/html', body });
    });
    const tree = new CategoryTree(join(f.dir, 'tree.json'));
    const saved = await tree.refresh(browser);
    assert.deepEqual(saved.categories.map(c => [c.id, c.path]), [['10', ['Lighting']], ['11', ['Lighting', 'Studio']], ['12', ['Lighting', 'Studio', 'Lamps']]]);
    assert.ok(visited.includes('/c/12/lamps')); assert.equal(tree.status().stale, false);
    const raw = readFileSync(tree.file, 'utf8');
    tree.crawl = b => crawlCategories(b, 1);
    await assert.rejects(tree.refresh(browser), /bound/); assert.equal(readFileSync(tree.file, 'utf8'), raw);
    writeFileSync(tree.file, JSON.stringify({ ...saved, fetchedAt: Date.now() - TREE_MAX_AGE - 1 }));
    assert.equal(await tree.fresh(browser), undefined); assert.equal(tree.read()?.categories.length, 3);
    assert.equal(categoryId('https://evil.test/c/3/test'), '');
  } finally { await real.close(); f.close(); }
});

test('tree selection sends item, price, cover and filtered categories to Everyday; validates exact paths and offers candidates', async () => {
  let answer = { confident: true, path: categories[0].path, candidates: [] as string[][] }, calls = 0;
  const f = fixture((async (_schema, _instructions, input, slot, _settings, images) => {
    calls++; const data = JSON.parse(input); assert.equal(slot, 'everyday'); assert.equal(data.price, '25'); assert.equal(data.title, 'Studio lamp');
    assert.deepEqual(images, [join(privateDir, 'photos', 'cover.jpg')]); assert.deepEqual(data.categories, categories.map(({ id, path }) => ({ id, path }))); return answer;
  }) as typeof ask);
  const flow = f.flow(); flow.categories = new CategoryTree(join(f.dir, 'tree.json'));
  writeFileSync(flow.categories.file, JSON.stringify({ fetchedAt: Date.now(), categories }));
  const d = f.store.create(); Object.assign(d, { title: 'Studio lamp', price: '25', description: 'Lamp with stand', coverId: 'cover' });
  try {
    await flow.analyze(d); assert.equal(d.categoryMethod, 'tree'); assert.deepEqual(d.category, categories[0].path); assert.equal(calls, 1);
    answer = { confident: false, path: [], candidates: categories.map(c => c.path) };
    await flow.analyze(d); assert.equal(d.state, 'needs_input'); assert.deepEqual(d.categoryCandidates, categories.map(c => c.path));
    let fallback = 0; flow.comparableCategory = async () => { fallback++; };
    answer = { confident: true, path: ['Invented'], candidates: [] }; await flow.analyze(d); assert.equal(fallback, 1);
    answer = { confident: false, path: [], candidates: [] }; await flow.analyze(d); assert.equal(fallback, 2);
    const large = { fetchedAt: Date.now(), categories: Array.from({ length: 400 }, (_, i) => ({ id: '' + i, path: [i === 390 ? 'Studio lamps' : `Other ${i}`], url: `https://mymarket.ge/c/${i}/` })) };
    const list = flow.categories.shortlist(large, d.title); assert.equal(list.length, 160); assert.equal(list[0].id, '390');
    assert.equal(flow.categories.shortlist(large, 'ქართული აღწერა').length, 400, 'no text overlap must not select an arbitrary prefix');
  } finally { f.close(); }
});

test('missing/stale trees and withdrawn live categories trigger fallback; comparable fallback tries four distinct searches', async () => {
  const f = fixture((async (_s, instructions) => instructions.startsWith('Suggest') ? { title: 'Lamp', query: 'studio lamp', queries: ['studio lamp', 'photography light', 'lamp stand', 'studio lighting'] } : { confident: true, index: 0 }) as typeof ask);
  const flow = f.flow(); flow.categories = new CategoryTree(join(f.dir, 'tree.json'), async () => { throw new Error('offline'); });
  const queries: string[] = []; flow.searchComparables = async (d, query) => { queries.push(query); if (queries.length === 1) throw new WorkflowError('SOURCE', 'no fit'); d.comparables.push({ url: 'https://mymarket.ge/pr/1/lamp', title: 'Lamp', breadcrumbs: categories[0].path }); };
  const d = f.store.create(); d.description = 'Studio lamp'; d.categoryMethod = 'tree';
  try {
    await flow.analyze(d); assert.equal(queries.length, 4); assert.equal(new Set(queries).size, 4); assert.equal(d.categoryMethod, 'comparable-search');
    writeFileSync(flow.categories.file, JSON.stringify({ fetchedAt: Date.now() - TREE_MAX_AGE - 1, categories }));
    queries.length = 0; await flow.analyze(d); assert.equal(queries.length, 4);
    d.categoryMethod = 'tree'; let prepares = 0;
    flow.prepareWithCategory = async () => { if (++prepares === 1) throw new WorkflowError('CATEGORY_UNAVAILABLE', 'withdrawn'); d.state = 'ready'; };
    queries.length = 0; await flow.prepareAI(d); assert.equal(prepares, 2); assert.equal(queries.length, 4); assert.equal(d.categoryMethod, 'comparable-search');
  } finally { f.close(); }
});

test('monitoring and deletion select the saved listing account rather than the last-used account', async () => {
  const f = fixture(), flow = f.flow();
  try {
    flow.accounts.add({ ...creds(), label: 'One' }); const two = flow.accounts.add({ ...creds(), label: 'Two' });
    const d = f.store.create('legacy'); d.title = 'Lamp'; d.price = '20';
    const record = { id: d.id, recipe: d, receipt: { url: 'https://mymarket.ge/pr/1/lamp', at: '', evidence: '' }, status: 'active' as const, enabled: true, missingCount: 0, nextCheckAt: 0, message: '', fingerprint: f.store.fingerprint(d) }; flow.archive.write(record);
    const selected: string[] = []; flow.useAccount = async d => { selected.push(d.accountId!); };
    flow.browser.open = async () => { throw new Error('stop before network'); };
    await assert.rejects(new ListingMonitor(flow).inspect(record)); assert.deepEqual(selected, ['legacy']);
    flow.auth.ensureSignedIn = async () => { throw new Error('stop before deletion'); };
    await flow.deleteListing(d.id); assert.deepEqual(selected, ['legacy', 'legacy']); assert.equal(flow.accounts.defaultId, two);
    assert.equal(flow.archive.get(d.id).status, 'attention');
  } finally { f.close(); }
});


test('live category response reconstructs numeric IDs and full paths, rejecting partial or cyclic trees', () => {
  const roots = [
    { id: 10, parent_id: 0, title: 'Lighting', seo_title: 'lighting/' },
    { id: 11, parent_id: 10, title: 'Studio', seo_title: 'lighting/studio/' },
    { id: 12, parent_id: 11, title: 'Lamps', seo_title: null },
  ];
  const result = categoriesFromResponse({ statusCode: 200, data: roots });
  assert.deepEqual(result.map(c => c.id), ['10', '11', '12']);
  assert.deepEqual(result[2].path, ['Lighting', 'Studio', 'Lamps']);
  assert.equal(categoryId(result[0].url), 'products/lighting'); assert.equal(categoryId(result[2].url), '12');
  assert.throws(() => categoriesFromResponse({ statusCode: 200, data: roots.slice(1) }), /incomplete/);
  assert.throws(() => categoriesFromResponse({ statusCode: 200, data: [{...roots[0], parent_id: 12}, ...roots.slice(1)] }), /cyclic/);
  assert.throws(() => categoriesFromResponse({ statusCode: 200, data: [...roots, roots[0]] }), /duplicate/);
});

test('crawler observes the menu category response without AI or traversing product listings', async () => {
  const real = await chromium.launch(), page = await real.newPage(), browser = new MarketplaceBrowser(); browser.page = page;
  try {
    const payload = { statusCode: 200, data: [{ id: 1, parent_id: 0, title: 'Lighting', seo_title: 'lighting/' }, { id: 2, parent_id: 1, title: 'Lamps', seo_title: 'lighting/lamps/' }] };
    await page.route('https://api.mymarket.ge/**', r => r.fulfill({ json: payload, headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route('https://mymarket.ge/**', r => r.fulfill({ contentType: 'text/html', body: '<button onclick="fetch(\'https://api.mymarket.ge/api/ka/categories\')">Categories</button>' }));
    const result = await crawlCategories(browser); assert.deepEqual(result.map(c => c.path), [['Lighting'], ['Lighting', 'Lamps']]);
    assert.equal(page.url(), 'https://mymarket.ge/');
  } finally { await real.close(); }
});

test('clearing credentials never allows an existing profile to be rebound to a different login identity', () => {
  const f = fixture(); f.vault.save(creds()); const flow = f.flow();
  try {
    const vault = flow.accounts.vault('legacy');
    vault.clear();
    assert.throws(() => vault.save({ identifier: 'other@x.io', password: randomUUID() }), /separate account/);
    const id = flow.accounts.add({ identifier: 'other@x.io', password: randomUUID(), label: 'Other' });
    assert.notEqual(id, 'legacy');
    assert.equal(flow.accounts.view().length, 2);
    vault.save(creds()); assert.equal(vault.configured, true);
  } finally { f.close(); }
});

test('a category removed from the observed select is reported for fallback rather than as a missing item fact', async () => {
  const f = fixture(), flow = f.flow(), real = await chromium.launch(), page = await real.newPage(); flow.browser.page = page;
  try {
    await page.setContent('<label>Category<select><option>Tables</option></select></label>');
    const d = f.store.create(); d.category = ['Lighting', 'Studio lamps'];
    const snapshot = await flow.browser.snapshot(page), target = snapshot.elements.find(e => e.tag === 'select')!;
    await assert.rejects(flow.step(page, snapshot, { action: 'select', source: 'category', target: target.id, value: 'Studio lamps', questions: [], reason: 'test' }, d, 'prepare', ''), (e: WorkflowError) => e.code === 'CATEGORY_UNAVAILABLE');
  } finally { await real.close(); f.close(); }
});
