import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { chromium, Browser, Page } from 'playwright';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { SettingsStore } from '../server/settings';
import { createApp } from '../server/app';
import { savePhoto } from '../server/photos';
import { accountField, controlField, plainLabel } from '../server/required-info';
import { WorkflowError } from '../server/types';

// The exact wording the owner saw when Publish stopped although the account had a saved phone.
const reported = "What mobile phone number should be used for the required contact field 'მობილურის ნომერი*' (e46)? It is not in the draft, so I cannot fill it.";
const newPhone = () => '5' + randomInt(10_000_000, 99_999_999);

async function withFlow<T>(run: (page: Page, flow: Workflow, phone: string, prompts: string[]) => Promise<T>) {
  const browser: Browser = await chromium.launch(), page = await browser.newPage();
  const root = mkdtempSync(join(tmpdir(), 'linko-contact-')), store = new Store(':memory:');
  const flow = new Workflow(store, (async () => { throw new WorkflowError('CODEX', 'not used'); }) as never, new CredentialVault(join(root, 'account.json'), false), new SettingsStore(join(root, 'settings.json')));
  flow.browser.page = page; flow.accounts.add({ label: 'Main', identifier: 'owner@x.io', password: randomUUID() });
  const phone = newPhone(), prompts: string[] = [];
  flow.accounts.saveDefaults('legacy', { location: 'თბილისი', phone });
  try { return await run(page, flow, phone, prompts); } finally { await browser.close(); store.db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('contact classification ignores required markers, spacing, element ids and language, and recognizes unlabeled tel controls', () => {
  for (const label of ['მობილურის ნომერი*', 'მობილურის ნომერი *', '  მობილურის   ნომერი  ', 'Mobile phone number *', 'Phone (e46)*', 'ტელეფონი', 'Телефон *', reported]) assert.equal(accountField({ key: '', label }), 'phone', label);
  for (const label of ['ქალაქი/ზუსტი მდებარეობა *', 'City*', 'Location', 'Город']) assert.equal(accountField({ key: '', label }), 'location', label);
  assert.equal(accountField({ key: '', label: 'Camera type' }), undefined);
  assert.equal(plainLabel('მობილურის ნომერი* (e46)'), 'მობილურის ნომერი');
  assert.equal(controlField({ label: '', controlId: 'name:contact_phone', type: 'text' }), 'phone');
  assert.equal(controlField({ label: '', controlId: 'id:Attr-text-4', type: 'tel' }), 'phone');
  assert.equal(controlField({ label: '', controlId: 'name:cityId', type: 'text' }), 'location');
  assert.equal(controlField({ label: 'Megapixels', controlId: 'name:mp', type: 'number' }), undefined);
});

test('the saved account phone fills every spelling of the contact field before any question is raised', { timeout: 60_000 }, async () => {
  await withFlow(async (page, flow, phone, prompts) => {
    flow.decide = async (_s, _i, input) => { prompts.push(input); return { action: 'done', questions: [] } as never; };
    for (const label of ['მობილურის ნომერი*', 'მობილურის ნომერი *', 'Mobile phone number *', 'ტელეფონი  *', 'Phone (e46) *']) {
      await page.setContent(`<label>${label}<input required></label>`);
      const draft = Object.assign(flow.store.create('legacy'), { automation: { steps: [] } });
      assert.ok(await flow.agent(page, draft, 'prepare', '', 6), label);
      assert.equal(await page.locator('input').inputValue(), phone, label);
      assert.deepEqual(draft.questions, [], label);
    }
    // A bare country-code prefix put there by the site is not a number; a real profile number is kept.
    await page.setContent('<label>მობილურის ნომერი *<input required value="+995 "></label>');
    assert.ok(await flow.agent(page, flow.store.create('legacy'), 'prepare', '', 6));
    assert.equal(await page.locator('input').inputValue(), phone);
    const profile = newPhone();
    await page.setContent(`<label>მობილურის ნომერი *<input required value="${profile}"></label>`);
    assert.ok(await flow.agent(page, flow.store.create('legacy'), 'prepare', '', 6));
    assert.equal(await page.locator('input').inputValue(), profile);
    // Unlabeled controls are found by their telephone type or stable name.
    await page.setContent('<input required type="tel"><input required name="contact_phone">');
    assert.ok(await flow.agent(page, flow.store.create('legacy'), 'prepare', '', 6));
    assert.deepEqual(await page.locator('input').evaluateAll(es => es.map(e => (e as HTMLInputElement).value)), [phone, phone]);
    assert.equal(prompts.some(p => p.includes(phone)), false, 'the phone never reaches a model prompt');
  });
});

test('the exact reported AI question about the mobile field (e46) is answered from the account default, never asked', { timeout: 60_000 }, async () => {
  await withFlow(async (page, flow, phone, prompts) => {
    // 46 other controls, then a required control the page gives no usable label (element id e46).
    await page.setContent(`${'<a href="https://mymarket.ge/x">link</a>'.repeat(46)}<input required name="field_9">`);
    let asked = 0;
    flow.decide = async (_s, _i, input) => {
      prompts.push(input);
      if (asked++ === 0) return { action: 'blocked', questions: [{ key: 'e46', label: reported, options: [] }], reason: '' } as never;
      return { action: 'done', questions: [] } as never;
    };
    const draft = Object.assign(flow.store.create('legacy'), { automation: { steps: [] } });
    const result = await flow.agent(page, draft, 'prepare', '', 8);
    assert.ok(result, 'the run continued instead of stopping with a question');
    assert.equal(await page.locator('input[name=field_9]').inputValue(), phone);
    assert.deepEqual(draft.questions, []); assert.notEqual(draft.state, 'needs_input');
    assert.equal(prompts.some(p => p.includes(phone)), false);
    // The same wording with no phone saved anywhere is a legitimate question.
    flow.accounts.saveDefaults('legacy', { location: 'თბილისი', phone: '' });
    await page.setContent('<label>მობილურის ნომერი*<input required></label>');
    const other = Object.assign(flow.store.create('legacy'), { automation: { steps: [] } });
    assert.equal(await flow.agent(page, other, 'prepare', '', 6), null);
    assert.equal(other.state, 'needs_input'); assert.equal(other.questions[0].label, 'მობილურის ნომერი*');
  });
});

test('a city default fills text and select city fields; an unfillable saved phone fails clearly instead of asking', { timeout: 60_000 }, async () => {
  await withFlow(async (page, flow, phone) => {
    flow.decide = async () => ({ action: 'done', questions: [] }) as never;
    await page.setContent('<label>Location *<input required></label><label>ქალაქი *<select required><option value="">-</option><option>ბათუმი</option><option>თბილისი</option></select></label>');
    const draft = Object.assign(flow.store.create('legacy'), { automation: { steps: [] } });
    assert.ok(await flow.agent(page, draft, 'prepare', '', 8));
    assert.equal(await page.locator('input').inputValue(), 'თბილისი'); assert.equal(await page.locator('select').inputValue(), 'თბილისი');
    // The phone control refuses input (a read-only widget): the problem is reported, the owner is not asked for a saved value.
    await page.setContent('<label>მობილურის ნომერი *<input required readonly></label>');
    const stuck = Object.assign(flow.store.create('legacy'), { automation: { steps: [] } });
    await assert.rejects(flow.agent(page, stuck, 'prepare', '', 12), (e: unknown) => e instanceof WorkflowError && !/cannot|ask|supply/i.test(e.message) && /saved phone/i.test(e.message));
    assert.deepEqual(stuck.questions, []); assert.ok(phone);
  });
});

test('an existing needs-input draft with the phone question publishes on the next Publish without retyping', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'linko-nikon-')), settings = new SettingsStore(join(root, 'settings.json'));
  const store = new Store(join(root, 'workspace.sqlite'), join(root, 'listings'));
  const flow = new Workflow(store, undefined, new CredentialVault(join(root, 'account.json'), false), settings);
  const accountId = flow.accounts.add({ label: 'Studio', identifier: 'owner@x.io', password: randomUUID() });
  const phone = newPhone(); flow.accounts.saveDefaults(accountId, { location: 'თბილისი', phone });
  const data = settings.load(); data.automation.publish = true; settings.save(data);
  const instance = createApp(store, flow), server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`, headers = { 'Content-Type': 'application/json', 'X-Linko-Request': '1' };
  try {
    const photo = await savePhoto(readFileSync('public/icons/icon-192.png'));
    const d = Object.assign(store.create(accountId), { title: 'Nikon D3400', model: 'D3400', description: 'Used camera', price: '250', photos: [photo], coverId: photo.id, category: ['Electronics', 'Cameras'], state: 'needs_input' as const, location: 'თბილისი', message: 'The live form needs a few more facts.', questions: [{ key: 'e46', label: reported, options: [] }, { key: 'Power', label: 'Power source', options: ['Battery'] }] });
    store.save(d);
    const view = await (await fetch(`${base}/drafts/${d.id}`)).json();
    assert.deepEqual(view.questions.map((q: { key: string }) => q.key), ['Power'], 'only the genuine question is still open');
    let row = (await (await fetch(`${base}/listings`)).json()).listings.find((r: { id: string }) => r.id === d.id);
    store.db.prepare("INSERT INTO jobs VALUES ('old',?,?,?,?)").run(d.id, 'submit', 'failed', Date.now());
    row = (await (await fetch(`${base}/listings`)).json()).listings.find((r: { id: string }) => r.id === d.id);
    assert.equal(row.reason, 'Required: Power source');
    // Publish: the contact question is dropped before anything runs; only the genuine one remains.
    flow.useAccount = async () => {}; flow.initializeDetails = async () => {};
    const seen: string[][] = [];
    flow.prepare = async draft => { seen.push(draft.questions.map(q => q.key)); draft.questions = []; draft.state = 'ready'; };
    flow.publish = async draft => { draft.state = 'published'; };
    const publish = await fetch(`${base}/drafts/${d.id}/publish`, { method: 'POST', headers, body: JSON.stringify({ revision: d.revision }) });
    assert.equal(publish.status, 202);
    await instance.queue.drain();
    assert.deepEqual(seen, [['Power']]); assert.equal(store.get(d.id).state, 'published');
    assert.equal(JSON.stringify(store.get(d.id)).includes(phone), false, 'the saved phone is not copied into the draft');
    // The same draft with only the contact question resumes with nothing left to answer.
    const e = Object.assign(store.create(accountId), { title: 'Nikon', description: 'Used', price: '5', photos: [photo], coverId: photo.id, category: ['Cameras'], state: 'needs_input' as const, questions: [{ key: 'e46', label: reported, options: [] }] });
    store.save(e); flow.settleContact(e);
    assert.deepEqual(e.questions, []); assert.equal(e.state, 'review');
  } finally { await new Promise<void>(r => server.close(() => r())); store.db.close(); rmSync(root, { recursive: true, force: true }); }
});
