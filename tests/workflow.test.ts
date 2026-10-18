import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { Workflow } from '../server/workflow';
import { Store } from '../server/store';
import { savePhoto } from '../server/photos';
import { config } from '../server/config';
import { ask } from '../server/codex';
import { MarketplaceBrowser } from '../server/browser';
import { ListingMonitor, MISSING_RECHECK } from '../server/listings';
test('semantic snapshots keep private field presence without values and recognize the live challenge', async () => {
  const browser = await chromium.launch(); const page = await browser.newPage(); const adapter = new MarketplaceBrowser(); adapter.page = page;
  try {
    await page.setContent('<label>Phone<input type="tel" required value="000000000"></label><label>Password<input type="password" value="fixture-only"></label><label>Category<select><option>Lighting</option></select></label>');
    const snapshot = await adapter.snapshot(); const phone = snapshot.elements.find(e => e.label === 'Phone')!;
    assert.equal(phone.value, ''); assert.equal(phone.hasValue, true); assert.equal(phone.required, true);
    assert.equal(snapshot.elements.find(e => e.type === 'password')?.value, ''); assert.equal(snapshot.elements.find(e => e.tag === 'select')?.label, 'Category');
    await page.setContent('<title>Just a moment...</title><p>Performing security verification</p>');
    await assert.rejects(adapter.snapshot(), /security check/);
  } finally { await browser.close(); }
});
test('connected semantic workflow: comparables, new live required field, review, guarded submit, durable receipt, stale form and unknown-response recovery', { timeout: 180000 }, async () => {
  const browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage();
  const store = new Store(':memory:'); let submits = 0, uncertain = false, deleted = false, deleted901 = false, deleted902 = false, changed = false, uncertainFix = false;
  const aiSlots: string[] = [];
  await context.route('https://mymarket.ge/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let html = '';
    if (path === '/') html = '<h1>MyMarket</h1><label>Search<input type="search" onkeydown="if(event.key===\'Enter\')location.href=\'/search/\'"></label><a href="/create">Add listing</a>';
    if (path === '/search/') html = '<h1>Results</h1><a href="/pr/111/lamp">Studio lamp</a><a href="/pr/112/lamp">Another lamp</a>';
    if (path.startsWith('/pr/111') || path.startsWith('/pr/112')) html = '<nav>Home &gt; Lighting &gt; Studio lamps</nav><h1>Studio lamp</h1><p>125 GEL</p>';
    if (path === '/create') html = `<h1>Create listing</h1><label>Category<select><option value="">Choose</option><option>Studio lamps</option></select></label><p>Home &gt; Lighting &gt; Studio lamps</p><label>Title<input required></label><label>Description<textarea required></textarea></label><label>Price<input required type="number"></label><label>Currency<select><option>GEL</option><option>USD</option></select></label><label>Power source<select required><option value="">Choose</option><option>Mains</option><option>Battery</option></select></label><label>Photos<input id="photos" type="file" accept="image/jpeg" multiple></label><div id="previews"></div><script>document.getElementById('photos').addEventListener('change',function(){const picked=Array.from(this.files);if(picked.length>1)picked.reverse();picked.forEach(function(f){const img=document.createElement('img');img.alt=f.name;img.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBmsAAAAASUVORK5CYII=';document.getElementById('previews').append(img)})})</script><button onclick="fetch('/submit',{method:'POST'}).then(r=>r.text()).then(t=>document.body.innerHTML=t)">Publish listing</button>`;
    if (path === '/submit') { submits++; html = uncertain ? '<h1>Thanks</h1>' : `<h1>Listing published successfully</h1><a href="/pr/${899 + submits}/lamp">View item</a>`; }
    if ((path.startsWith('/pr/900') && deleted) || (path.startsWith('/pr/901') && deleted901) || (path.startsWith('/pr/902') && deleted902)) { await route.fulfill({ status: 404, contentType: 'text/html', body: 'Listing removed' }); return; }
    if (/^\/pr\/90\d/.test(path)) html = '<h1>Studio lamp with stand</h1><p>125 GEL</p>';
    if (path === '/create' && changed) html = html.replace('<label>Description', '<label>' + (uncertainFix ? 'Other details' : 'Item description'));
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  const brain: typeof ask = (async (_schema: unknown, instructions: string, input: string, slot = 'everyday') => {
    aiSlots.push(slot);
    const v = JSON.parse(input);
    if (instructions.startsWith('Look up product')) return { description: '', answers: [] };
    if (instructions.startsWith('Suggest')) return { title: 'Studio lamp with stand', query: 'Studio lamp', queries: ['Studio lamp', 'Photography lighting', 'Lamp with stand'] };
    if (instructions.startsWith('Choose one')) return { urls: v.links.map((e: any) => e.href).filter((url: string) => url.includes('/pr/')) };
    if (instructions.startsWith('Inspect this')) return { relevant: true, title: 'Studio lamp', breadcrumbs: ['Home', 'Lighting', 'Studio lamps'] };
    if (instructions.startsWith('Choose the best')) return { index: 0, confident: true };
    if (instructions.startsWith('Compare only')) return { equivalent: true };
    if (instructions.startsWith('Audit the final')) return { categoryMatches: true, fieldsMatch: true, photosPresent: v.page.images.length === 2, questions: [], fields: v.page.elements.filter((e: any) => ['Title', 'Description', 'Item description', 'Price', 'Power source'].includes(e.label)).map((e: any) => ({ label: e.label, value: e.value, source: e.label })) };
    if (instructions.startsWith('Perform the final')) return { matches: true };
    if (instructions.startsWith('Check explicit')) return { succeeded: !uncertain, url: uncertain ? '' : `https://mymarket.ge/pr/${899 + submits}/lamp`, confirmation: uncertain ? '' : 'Listing published successfully' };
    const elements = v.page.elements as any[];
    if (uncertainFix) return { action: 'blocked', target: '', source: '', value: '', questions: [], reason: 'Uncertain changed page' };
    const decision = (action: string, label = '', source = '', value = '') => { return { action, target: elements.find(e => e.label === label)?.id || '', source, value, questions: [], reason: 'Fixture semantic decision' }; };
    if (v.task.startsWith('Search')) {
      if (v.page.text.includes('Results')) return decision('done');
      if (!elements.find(e => e.label === 'Search')?.value) return decision('fill', 'Search', 'query', v.query);
      return decision('search_enter', 'Search');
    }
    if (v.page.url.endsWith('/')) return decision('click', 'Add listing');
    const category = elements.find(e => e.label === 'Category'); if (!category.value) return decision('select', 'Category', 'category', 'Studio lamps');
    if (v.task.startsWith('Read the live category form')) return decision('done');
    for (const [label, source] of [['Title', 'title'], [changed ? 'Item description' : 'Description', 'description'], ['Price', 'price']]) if (!elements.find(e => e.label === label)?.value) return decision('fill', label, source, v.draft[source]);
    if (!v.draft.facts['Power source']) return { ...decision('blocked'), questions: [{ key: 'Power source', label: 'Power source', options: ['Mains', 'Battery'] }] };
    if (!elements.find(e => e.label === 'Power source')?.value) return decision('select', 'Power source', 'facts.Power source', v.draft.facts['Power source']);
    if (!v.uploaded) return decision('upload', 'Photos');
    return decision('done');
  }) as typeof ask;
  const flow = new Workflow(store, brain); flow.browser.page = page; flow.browser.context = context;
  const draft = store.create(); const photos = [await savePhoto(readFileSync('public/icons/icon-512.png')), await savePhoto(readFileSync('public/icons/icon-192.png'))];
  Object.assign(draft, { description: 'A used studio lamp with original stand.', price: '125', photos, coverId: photos[1].id }); store.save(draft);
  const previous = config.publish, previousRelist = config.autoRelist; config.publish = true;
  try {
    await flow.run(draft.id, 'analyze'); const analyzed = store.get(draft.id); assert.equal(analyzed.state, 'needs_input', analyzed.message); assert.equal(analyzed.specFields?.[0].label, 'Power source'); assert.equal(analyzed.coverId, photos[1].id); assert.equal(analyzed.comparables.length, 2); assert.deepEqual(analyzed.category, ['Home', 'Lighting', 'Studio lamps']);
    await flow.run(draft.id, 'prepare'); const needs = store.get(draft.id); assert.equal(needs.state, 'needs_input', needs.message); assert.equal(needs.questions[0].key, 'Power source'); assert.equal(submits, 0);
    needs.facts['Power source'] = 'Mains'; needs.revision++; store.save(needs);
    await flow.run(draft.id, 'prepare'); const ready = store.get(draft.id); assert.equal(ready.state, 'ready', ready.message); assert.ok(ready.fields.some(f => f.value === 'Mains')); assert.equal(submits, 0);
    // The fixture gallery (like the live uploader) shows a multi-file selection in the wrong order, so only one-at-a-time uploads pass.
    assert.deepEqual(await page.locator('#previews img').evaluateAll(es => es.map(e => (e as HTMLImageElement).alt)), [photos[1].id + '.jpg', photos[0].id + '.jpg']);
    await page.getByLabel('Price', { exact: true }).fill('999'); await flow.run(draft.id, 'publish'); assert.equal(submits, 0); assert.equal(store.get(draft.id).state, 'blocked');
    await flow.run(draft.id, 'prepare'); assert.equal(store.get(draft.id).state, 'ready'); await flow.run(draft.id, 'publish');
    const published = store.get(draft.id); assert.equal(submits, 1); assert.equal(published.state, 'published'); assert.equal(published.receipt?.url, 'https://mymarket.ge/pr/900/lamp');
    const record = flow.archive.get(draft.id); assert.ok(readFileSync(store.archiveDir + '/' + draft.id + '.md', 'utf8').includes('Power source'));
    config.autoRelist = true; deleted = true; record.nextCheckAt = 0; flow.archive.write(record); flow.prepared = undefined;
    const monitor = new ListingMonitor(flow), now = Date.now();
    const callsBeforeReplay = aiSlots.length;
    await monitor.check(now); assert.equal(submits, 1);
    await monitor.check(now + MISSING_RECHECK); assert.equal(submits, 2);
    assert.equal(aiSlots.length, callsBeforeReplay, 'Saved recipe relist including receipt must make zero AI calls');
    const replaced = flow.archive.get(draft.id); assert.equal(replaced.status, 'replaced', replaced.message);
    const restored = store.get(replaced.replacementId!); assert.equal(restored.state, 'published'); assert.equal(restored.receipt?.url, 'https://mymarket.ge/pr/901/lamp');
    assert.deepEqual(restored.photos, published.photos); assert.equal(restored.coverId, published.coverId); assert.deepEqual(restored.facts, published.facts);
    // A changed live label breaks deterministic matching, invokes only Fix-it and learns the replacement recipe.
    const notice: string[] = []; flow.telegram.notify = text => { notice.push(text); };
    changed = true; deleted901 = true; const r901 = flow.archive.get(restored.id); r901.nextCheckAt = 0; flow.archive.write(r901); flow.prepared = undefined;
    const fixStart = aiSlots.length, secondNow = now + MISSING_RECHECK + 1;
    await monitor.check(secondNow); await monitor.check(secondNow + MISSING_RECHECK);
    const r901After = flow.archive.get(restored.id); assert.equal(r901After.status, 'replaced', r901After.message); assert.equal(submits, 3);
    assert.ok(aiSlots.length > fixStart); assert.ok(aiSlots.slice(fixStart).every(s => s === 'fixit'));
    const fixed = flow.archive.get(r901After.replacementId!); assert.ok(fixed.recipe.automation?.steps.some(s => s.target.label === 'Item description'));
    assert.ok(notice.some(t => t.includes('AI Fix-it started'))); assert.ok(notice.some(t => t.includes('AI fix succeeded'))); assert.ok(notice.some(t => t.includes('Re-list succeeded') && t.includes('/902/')));
    // Another changed page with an uncertain model stops with attention and can never auto-retry.
    uncertainFix = true; deleted902 = true; fixed.nextCheckAt = 0; flow.archive.write(fixed); flow.prepared = undefined;
    const thirdNow = secondNow + MISSING_RECHECK + 1;
    await monitor.check(thirdNow); await monitor.check(thirdNow + MISSING_RECHECK);
    assert.equal(flow.archive.get(fixed.id).status, 'attention'); assert.equal(submits, 3);
    assert.ok(notice.some(t => t.includes('Attention')));
    await monitor.check(thirdNow + MISSING_RECHECK + 3*60*60_000); assert.equal(submits, 3);
    uncertainFix = false; changed = false;
    const second = store.create(); Object.assign(second, { ...published, id: second.id, state: 'review', title: 'Another lamp', revision: 0 }); store.save(second);
    // The fixture model fills the explicitly supplied second title; no success is inferred from a generic response.
    uncertain = true; await flow.run(second.id, 'prepare'); assert.equal(store.get(second.id).state, 'ready'); await flow.run(second.id, 'publish'); assert.equal(store.get(second.id).state, 'unknown'); assert.equal(submits, 4);
    const retry = store.get(second.id); retry.state = 'review'; store.save(retry); await flow.run(second.id, 'prepare'); await flow.run(second.id, 'publish'); assert.equal(submits, 4); assert.match(store.get(second.id).message, /already has a publishing attempt/);
  } finally { config.publish = previous; config.autoRelist = previousRelist; await browser.close(); store.db.close(); }
});
