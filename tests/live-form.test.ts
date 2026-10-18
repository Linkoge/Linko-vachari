import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, Browser, Page } from 'playwright';
import { Workflow } from '../server/workflow';
import { Store } from '../server/store';
import { savePhoto } from '../server/photos';
import { MarketplaceBrowser, allowedUrl, isAuthHost, onAuthPage } from '../server/browser';
import { WorkflowError } from '../server/types';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault } from '../server/credentials';
import { controls, privateControl } from '../server/replay';

// Shapes below were observed on the live, signed-in mymarket.ge listing form (react-select dropdowns, `fast-option` rows,
// button-styled radios tracked by an `active` class, an uploader that appends thumbnails named after the uploaded file).
async function withPage<T>(run: (page: Page, adapter: MarketplaceBrowser, flow: Workflow) => Promise<T>) {
  const browser: Browser = await chromium.launch(); const page = await browser.newPage();
  const adapter = new MarketplaceBrowser(); adapter.page = page; const store = new Store(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'linko-live-form-'));
  const flow = new Workflow(store, (async () => { throw new WorkflowError('CODEX', 'not used'); }) as never, new CredentialVault(join(root, 'account.json'), false)); flow.browser = adapter;
  try { return await run(page, adapter, flow); } finally { await browser.close(); store.db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('single sign-on hops between Tinet auth hosts are navigable and counted as sign-in pages, look-alikes are not', () => {
  for (const host of ['auth.tnet.ge', 'accounts.tnet.ge', 'auth.myauto.ge', 'auth.myparts.ge', 'id.my.ge']) assert.equal(isAuthHost(host), true, host);
  assert.equal(allowedUrl('https://auth.myauto.ge/?AccessToken=x'), true); assert.equal(onAuthPage('https://auth.myauto.ge/?AccessToken=x'), true);
  for (const url of ['https://auth.myauto.ge.evil.example/', 'https://evil-auth.myauto.ge.example/', 'https://myauto.ge.evil.example/', 'http://auth.myauto.ge/', 'chrome-error://chromewebdata/', 'about:blank']) assert.equal(allowedUrl(url), false, url);
  assert.equal(allowedUrl('https://myauto.ge/'), false, 'only the auth host of a sibling platform, not the whole site');
});

test('snapshots survive a navigation swapping the document and describe custom dropdowns, option rows and styled radios', async () => {
  await withPage(async (page, adapter) => {
    await page.setContent(`<div><label class="t">Silent *</label></div><div><div class="sg-selectbox__control"><div class="sg-selectbox__placeholder">აირჩიე</div><input role="combobox" type="text"></div></div>
      <div><div class="t">Colour</div></div><div><div class="sg-selectbox__control"><div class="sg-selectbox__single-value">შავი</div><input role="combobox" type="text"></div></div>
      <div><div class="fast-option">თბილისი</div></div>
      <div><div class="t">Wireless</div></div><div><input type="radio" name="w" id="y" class="btn-check active"><label for="y">დიახ</label><input type="radio" name="w" id="n" class="btn-check"><label for="n">არა</label></div>`);
    const snap = await adapter.snapshot();
    const [silent, colour] = snap.elements.filter(e => e.role === 'combobox');
    assert.equal(silent.label, 'Silent *'); assert.equal(silent.required, true); assert.equal(silent.hasValue, false);
    assert.equal(colour.label, 'Colour'); assert.equal(colour.hasValue, true); assert.equal(colour.value, 'შავი');
    assert.deepEqual(snap.elements.filter(e => e.role === 'option').map(e => e.label), ['თბილისი']);
    const yes = snap.elements.find(e => e.label === 'დიახ')!, no = snap.elements.find(e => e.label === 'არა')!;
    assert.equal(yes.checked, true); assert.equal(yes.hasValue, true); assert.equal(no.hasValue, false); assert.equal(yes.group, 'Wireless');
    // A click that navigates leaves the old execution context behind once; the observation is retried against the new document.
    const real = (adapter as any).observe.bind(adapter); let failures = 1;
    (adapter as any).observe = async (p: Page) => { if (failures-- > 0) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'); return real(p); };
    assert.ok((await adapter.snapshot()).elements.length > 0); assert.equal(failures, -1);
    (adapter as any).observe = async () => { throw new Error('something unrelated'); };
    await assert.rejects(adapter.snapshot(), /unrelated/);
  });
});

test('hidden styled radios are selected through their label and verified; custom dropdowns open instead of being "selected"', async () => {
  await withPage(async (page, adapter, flow) => {
    await page.setContent(`<style>.btn-check{position:absolute;clip:rect(0 0 0 0)}label{display:inline-block;padding:8px}</style>
      <input type="radio" name="c" id="u" class="btn-check active" checked><label for="u">მეორადი</label><input type="radio" name="c" id="x" class="btn-check"><label for="x">ახალი</label>
      <div id="menu"></div><input role="combobox" type="text" aria-label="Location" onclick="menu.textContent='open'">
      <script>document.querySelectorAll('.btn-check').forEach(r=>r.addEventListener('change',()=>document.querySelectorAll('.btn-check').forEach(o=>o.classList.toggle('active',o.checked))))</script>`);
    await flow.toggle(page, page.locator('#x'), true);
    assert.equal(await page.locator('#x').evaluate(e => e.classList.contains('active')), true); assert.equal(await page.locator('#u').evaluate(e => e.classList.contains('active')), false);
    await flow.toggle(page, page.locator('#x'), true); // already selected: no-op, no error
    // A radio that never becomes selected is reported instead of silently skipped.
    await page.evaluate(() => document.querySelectorAll('.btn-check').forEach(r => r.addEventListener('click', e => e.preventDefault())));
    await assert.rejects(flow.toggle(page, page.locator('#u'), true), /could not be selected/);
    const snap = await adapter.snapshot(); const draft = flow.store.create(); const combo = snap.elements.find(e => e.role === 'combobox')!;
    await flow.step(page, snap, { action: 'select', target: combo.id, source: 'location', value: 'თბილისი', questions: [], reason: '' }, Object.assign(draft, { location: 'Tbilisi' }), 'prepare', '');
    assert.equal(await page.locator('#menu').textContent(), 'open');
  });
});

test('fill uses the draft value, not the model wording, and a missing source value is still refused', async () => {
  await withPage(async (page, adapter, flow) => {
    await page.setContent('<label>Title<input></label><label>Phone<input></label>');
    const snap = await adapter.snapshot(); const draft = Object.assign(flow.store.create(), { title: 'Used mouse' });
    const title = snap.elements.find(e => e.label === 'Title')!, phone = snap.elements.find(e => e.label === 'Phone')!;
    await flow.step(page, snap, { action: 'fill', target: title.id, source: 'title', value: 'Used mouse ⁂ garbled', questions: [], reason: '' }, draft, 'prepare', '');
    assert.equal(await page.getByLabel('Title').inputValue(), 'Used mouse');
    await assert.rejects(flow.step(page, snap, { action: 'fill', target: title.id, source: 'model', value: 'invented', questions: [], reason: '' }, draft, 'prepare', ''), /not been supplied/);
    await assert.rejects(flow.step(page, snap, { action: 'fill', target: phone.id, source: 'title', value: 'x', questions: [], reason: '' }, draft, 'prepare', ''), /not been supplied/);
  });
});

test('photos upload one at a time in cover-first order and a scrambled gallery is rejected', { timeout: 90_000 }, async () => {
  await withPage(async (page, adapter, flow) => {
    const photos = [await savePhoto(readFileSync('public/icons/icon-512.png')), await savePhoto(readFileSync('public/icons/icon-192.png')), await savePhoto(readFileSync('public/icons/icon-512.png'))];
    const ids = [photos[1].id, photos[0].id, photos[2].id];
    const gallery = (reverse: boolean) => `<input id="f" type="file" multiple><div id="g"></div><script>f.addEventListener('change',async()=>{const l=Array.from(f.files);if(${reverse})l.reverse();for(const x of l){await new Promise(r=>setTimeout(r,x.name===l[0].name?300:50));const i=new Image();i.alt=x.name;i.width=20;i.height=20;i.src='data:image/gif;base64,R0lGODlhAQABAAAAACw=';g.append(i)}})</script>`;
    await page.setContent(gallery(false));
    await flow.uploadInOrder(page, page.locator('#f'), ids);
    assert.deepEqual(await page.locator('#g img').evaluateAll(es => es.map(e => (e as HTMLImageElement).alt)), ids.map(id => id + '.jpg'));
    await page.setContent(`<input id="f" type="file"><div id="g"><img alt="${ids[2]}.jpg" width="5" height="5" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div><script>f.addEventListener('change',()=>{const i=new Image();i.alt=f.files[0].name;i.width=5;i.height=5;i.src='data:image/gif;base64,R0lGODlhAQABAAAAACw=';g.append(i)})</script>`);
    // A gallery that already holds a later photo ahead of the cover (as if MyMarket reordered them) must stop the run before review.
    await assert.rejects(flow.uploadInOrder(page, page.locator('#f'), ids), /different order/);
  });
});

test('account defaults fill required city/mobile, allow listing city overrides and preserve a profile phone', async () => {
  await withPage(async (page, adapter, flow) => {
    const previous = flow.accounts.defaults('legacy'), phone = '5' + randomInt(10_000_000, 99_999_999);
    const cityLabel = 'ქალაქი/ზუსტი მდებარეობა *', mobileLabel = 'მობილურის ნომერი *';
    assert.equal(flow.accounts.add({ label: 'Primary', identifier: 'first@x.io', password: randomUUID() }), 'legacy');
    flow.accounts.saveDefaults('legacy', { location: 'თბილისი', phone });
    const other = flow.accounts.add({ label: 'Other', identifier: 'other@x.io', password: randomUUID() });
    flow.accounts.saveDefaults(other, { location: 'ბათუმი', phone: '5' + randomInt(10_000_000, 99_999_999) });
    assert.equal(flow.accounts.defaultId, other); // Last-used account must not supply this listing's contact data.
    const draft = flow.store.create('legacy'); draft.automation = { steps: [] };
    const prompts: string[] = [];
    flow.decide = async (_schema, _instructions, input) => { prompts.push(input); return { action: 'done', questions: [] } as never; };
    try {
      await page.setContent(`<label>${cityLabel}<select required><option value="">Choose</option><option value="14">თბილისი</option><option value="96">ბათუმი</option></select></label><label>${mobileLabel}<input type="tel" required></label>`);
      assert.ok(await flow.agent(page, draft, 'prepare', '', 8));
      assert.equal(await page.getByLabel(cityLabel).inputValue(), '14');
      assert.equal(await page.getByLabel(mobileLabel).inputValue(), phone);
      const snap = await adapter.snapshot();
      assert.equal(snap.elements.find(e => e.label === mobileLabel)?.value, '');
      assert.equal(privateControl(snap.elements.find(e => e.label === mobileLabel)!), true);
      assert.equal(JSON.stringify(controls(snap)).includes(mobileLabel), false);
      assert.equal(prompts.some(p => p.includes(phone)), false);
      draft.location = 'ბათუმი';
      assert.ok(await flow.agent(page, draft, 'prepare', '', 8));
      assert.equal(await page.getByLabel(cityLabel).inputValue(), '96');
      assert.equal(flow.accounts.defaults('legacy').location, 'თბილისი');
      const profileNumber = '5' + randomInt(10_000_000, 99_999_999);
      await page.getByLabel(mobileLabel).fill(profileNumber);
      flow.accounts.saveDefaults('legacy', { location: 'თბილისი', phone: '' });
      assert.ok(await flow.agent(page, draft, 'prepare', '', 8));
      assert.equal(await page.getByLabel(mobileLabel).inputValue(), profileNumber);
      await page.getByLabel(mobileLabel).fill('');
      assert.equal(await flow.agent(page, draft, 'prepare', '', 8), null);
      assert.equal(draft.state, 'needs_input'); assert.equal(draft.questions[0].label, mobileLabel);
      draft.facts[draft.questions[0].key] = phone;
      assert.ok(await flow.agent(page, draft, 'prepare', '', 8));
      assert.equal(await page.getByLabel(mobileLabel).inputValue(), phone);
      assert.equal(prompts.some(p => p.includes(phone)), false);
    } finally { flow.accounts.saveDefaults('legacy', previous); }
  });
});
