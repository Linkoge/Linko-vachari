import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { SettingsStore } from '../server/settings';
import { fillDetails } from '../server/details';
import { SpecCache, snapshotFields, matchingControls, specSchemaVersion } from '../server/specs';
import { decisionSchemas, estimateSchema } from '../server/decision-schemas';
import { codexArgs, claudeArgs, ask } from '../server/codex';
import { createApp } from '../server/app';
import { savePhoto } from '../server/photos';
import { privateDir } from '../server/config';
import type { SpecField, Draft } from '../server/types';

const camera: SpecField = { key: 'Camera type', label: 'Camera type', required: true, options: ['DSLR', 'Mirrorless', 'Compact'], kind: 'spec' };
const wheel: SpecField = { key: 'Wheel diameter', label: 'Wheel diameter', required: true, options: ['64 mm', '72 mm', '80 mm'], kind: 'spec' };
const ownerFields: SpecField[] = ['Condition', 'Included accessories', 'Defects'].map(label => ({ key: label, label, required: true, options: [], kind: 'owner' }));
const answer = (key: string, value: string, source = 'lookup') => ({ key, value, source, evidence: source === 'lookup' ? 'DX-format DSLR' : 'Used', url: source === 'lookup' ? 'https://www.nikon.test/d3400/specifications' : '' });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'linko-specs-'));
  const store = new Store(join(dir, 'workspace.sqlite'), join(dir, 'listings'));
  const flow = new Workflow(store, undefined, new CredentialVault(join(dir, 'account.json'), false), new SettingsStore(join(dir, 'settings.json')));
  const draft = Object.assign(store.create('legacy'), { title: 'Nikon D3400', model: 'D3400', description: 'Used Nikon D3400.', price: '250', category: ['Electronics', 'Cameras'] });
  return { dir, store, flow, draft, close() { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('camera leaf reads live schema up front, looks up DSLR with Everyday and cover, rewrites, then reuses persisted category schema', async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  let reads = 0, lookups = 0;
  try {
    f.flow.browser.page = page;
    f.flow.auth.ensureSignedIn = async () => { reads++; await page.setContent('<label>Title<input required></label><label>Camera type<select required><option value="">Choose</option><option value="dslr">DSLR</option><option>Mirrorless</option><option>Compact</option></select></label><label>Megapixels<input type="number"></label><button>Publish listing</button>'); return true; };
    f.flow.brain = (async (schema: unknown, _instructions, input, slot, _settings, images, options) => {
      if (schema === decisionSchemas.descriptionCheck) return { sameLanguage: true, factsSupported: true };
      if (schema === decisionSchemas.action) return { action: 'done', questions: [] };
      assert.equal(schema, decisionSchemas.details); assert.equal(slot, 'everyday'); assert.equal(options?.lookup, true);
      assert.match(images![0], /photos\/cover-fixture.jpg$/); assert.equal(JSON.parse(input).ownerText.includes('Used'), true); lookups++;
      return { description: 'Used Nikon D3400. DSLR camera with a 24.2 MP DX sensor.', answers: [answer(camera.key, 'DSLR'), answer('Megapixels', '24.2')] };
    }) as typeof ask;
    f.draft.coverId = 'cover-fixture';
    await f.flow.initializeDetails(f.draft);
    assert.equal(f.draft.facts['Camera type'], 'DSLR'); assert.equal(f.draft.facts.Megapixels, '24.2');
    assert.equal(f.draft.state, 'review'); assert.equal(f.draft.originalDescription, 'Used Nikon D3400.');
    assert.match(f.draft.description, /24.2 MP/); assert.equal(f.draft.descriptionRewritten, true);
    assert.equal(f.draft.detailSources?.['Camera type'], 'lookup');
    assert.deepEqual(f.draft.specFields?.find(s => s.key === camera.key), camera);
    assert.deepEqual(new SpecCache(f.flow.specCache.file).get(f.draft.category), f.draft.specFields);
    const next = Object.assign(f.store.create('legacy'), { ...f.draft, id: 'next-camera', facts: {}, originalDescription: undefined, description: 'Used Nikon D3400.' });
    await f.flow.initializeDetails(next); assert.equal(reads, 1); assert.equal(lookups, 2);
    assert.equal(next.facts[camera.key], 'DSLR');
  } finally { await browser.close(); f.close(); }
});

test('lookup rejects invented select values and unknown required fields become inline questions when estimating is off', async () => {
  const f = fixture();
  try {
    f.flow.brain = (async () => ({ description: '', answers: [answer(camera.key, 'SLR invented option')] })) as typeof ask;
    await fillDetails(f.flow, f.draft, [camera, wheel]);
    assert.deepEqual(f.draft.facts, {}); assert.deepEqual(f.draft.questions.map(q => q.key), [camera.key, wheel.key]);
    assert.equal(f.draft.specFields?.length, 2); assert.equal(f.store.get(f.draft.id).questions.length, 2);
  } finally { f.close(); }
});

test('estimate checkbox fills every undetermined required/offered spec from live options and never estimates owner/account facts', async () => {
  const f = fixture(); const optional = { ...wheel, key: 'Bearing', label: 'Bearing', required: false, options: ['ABEC-5', 'ABEC-7'] };
  try {
    f.draft.title = 'Cheap roller skates'; f.draft.estimateMissing = true;
    let estimates = 0;
    f.flow.brain = (async (schema: unknown, instructions, input, slot, _settings, _images, options) => {
      assert.equal(slot, 'everyday');
      if (schema === decisionSchemas.details) return { description: '', answers: ownerFields.map(f => answer(f.key, 'Perfect', 'lookup')) };
      assert.match(instructions, /Estimate the most likely/); assert.equal(options?.lookup, undefined);
      assert.deepEqual(JSON.parse(input).fields.map((f: SpecField) => f.key), [wheel.key, 'Bearing']); estimates++;
      return { values: { [wheel.key]: '72 mm', Bearing: 'ABEC-5' } };
    }) as typeof ask;
    await fillDetails(f.flow, f.draft, [wheel, optional, ...ownerFields]);
    assert.equal(estimates, 1); assert.equal(f.draft.facts[wheel.key], '72 mm'); assert.equal(f.draft.facts.Bearing, 'ABEC-5');
    assert.equal(f.draft.detailSources?.[wheel.key], 'estimated');
    assert.deepEqual(f.draft.questions.map(q => q.key), ownerFields.map(f => f.key));
    assert.equal(f.draft.price, '250'); assert.equal(f.draft.location, ''); assert.equal(f.draft.facts.phone, undefined);
  } finally { f.close(); }
});

test('lookup failure still estimates specs when enabled; invalid estimates cannot escape live enums', async () => {
  const f = fixture(); f.draft.estimateMissing = true;
  try {
    f.flow.brain = (async (schema: unknown) => { if (schema === decisionSchemas.details) throw new Error('timeout'); return { values: { [wheel.key]: '80 mm' } }; }) as typeof ask;
    await fillDetails(f.flow, f.draft, [wheel]); assert.deepEqual(f.draft.questions, []); assert.equal(f.draft.facts[wheel.key], '80 mm');
    f.draft.facts = {}; f.flow.brain = (async (schema: unknown) => schema === decisionSchemas.details ? { description: '', answers: [] } : { values: { [wheel.key]: '200 mm' } }) as typeof ask;
    await assert.rejects(fillDetails(f.flow, f.draft, [wheel])); assert.equal(f.draft.facts[wheel.key], undefined);
  } finally { f.close(); }
});

const patch = (d: Draft, values = {}) => ({ revision: d.revision, title: d.title, description: d.description, price: d.price, currency: d.currency, model: d.model, condition: d.condition, location: d.location, category: d.category, facts: d.facts, coverId: d.coverId, estimateMissing: d.estimateMissing, ...values });
test('API persists edited selects, rejects non-options, remembers both estimate defaults, and saves description undo', async () => {
  const f = fixture(), server = createApp(f.store, f.flow).app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`, headers = { 'Content-Type': 'application/json', 'X-Linko-Request': '1' };
  try {
    const older = f.store.create('legacy');
    Object.assign(f.draft, { specFields: [camera], facts: { [camera.key]: 'DSLR' }, detailSources: { [camera.key]: 'lookup' }, originalDescription: f.draft.description, description: 'Improved camera description.', descriptionRewritten: true, fields: [{ label: 'Camera type', value: 'DSLR', source: 'facts.Camera type' }] }); f.store.save(f.draft);
    const save = (d: Draft, values: object) => fetch(`${base}/drafts/${d.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch(d, values)) });
    assert.equal((await save(f.draft, { facts: { [camera.key]: 'invented' } })).status, 409);
    let response = await save(f.draft, { description: f.draft.originalDescription, facts: { [camera.key]: 'Mirrorless' }, estimateMissing: true });
    assert.equal(response.status, 200); let saved = await response.json() as Draft;
    assert.equal(saved.descriptionRewritten, false); assert.equal(saved.description, 'Used Nikon D3400.');
    assert.deepEqual(saved.fields, []); assert.equal(saved.ownerDescription, 'Used Nikon D3400.');
    assert.equal(saved.facts[camera.key], 'Mirrorless'); assert.equal(saved.detailSources?.[camera.key], 'owner');
    assert.equal((await save(older, { title: 'Old draft edited after default changed' })).status, 200);
    assert.equal((await (await fetch(base + '/drafts', { method: 'POST', headers, body: '{}' })).json() as Draft).estimateMissing, true);
    response = await save(saved, { estimateMissing: false }); saved = await response.json() as Draft;
    assert.equal(response.status, 200); assert.equal(saved.estimateMissing, false);
    const reopened = new Store(join(f.dir, 'workspace.sqlite'), join(f.dir, 'listings'));
    assert.equal(reopened.create().estimateMissing, false); reopened.db.close();
  } finally { await new Promise<void>(r => server.close(() => r())); f.close(); }
});

test('only specification lookup enables web tools on either provider', () => {
  const choice = { provider: 'codex' as const, model: 'chosen', effort: 'low' as const };
  assert.ok(codexArgs('/tmp/job', choice).includes('web_search="disabled"'));
  const args = codexArgs('/tmp/job', choice, [], true);
  assert.ok(args.includes('web_search="live"')); assert.ok(args.includes('features.shell_tool=false'));
  assert.equal(claudeArgs(choice, {})[claudeArgs(choice, {}).indexOf('--tools') + 1], '');
  assert.equal(claudeArgs(choice, {}, true)[claudeArgs(choice, {}, true).indexOf('--tools') + 1], 'WebSearch,WebFetch');
});

for (const estimateMissing of [false, true]) test(`prepare refreshes stale schema and ${estimateMissing ? 'estimates a new spec and continues' : 'asks inline about a new unknown spec'}`, { timeout: 60_000 }, async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  const photo = await savePhoto(readFileSync('public/icons/icon-192.png'));
  try {
    f.flow.browser.page = page; f.flow.useAccount = async () => {};
    f.flow.auth.ensureSignedIn = async () => { await page.setContent(`<label>Title<input required></label><label>Description<textarea required></textarea></label><label>Price<input required type="number"></label><label>Camera type<select required><option value="">Choose</option><option value="dslr">DSLR</option><option>Mirrorless</option><option>Compact</option></select></label><label>Wheel diameter<select required><option value="">Choose</option><option>64 mm</option><option>72 mm</option><option>80 mm</option></select></label><input type="file" aria-label="Photos"><div id="gallery"></div><script>document.querySelector('input[type=file]').onchange=e=>{const i=new Image();i.alt=e.target.files[0].name;i.width=10;i.height=10;i.src='data:image/gif;base64,R0lGODlhAQABAAAAACw=';document.getElementById('gallery').append(i)}</script><button>Publish listing</button>`); return true; };
    Object.assign(f.draft, { specFields: [camera], facts: { [camera.key]: 'DSLR' }, photos: [photo], coverId: photo.id, estimateMissing });
    f.flow.specCache.set(f.draft.category, [camera]);
    f.flow.brain = (async (schema: unknown, _instructions, input, _slot, _settings, _images, options) => {
      const v = JSON.parse(input);
      if (schema === decisionSchemas.details) { assert.equal(options?.lookup, true); return { description: '', answers: [] }; }
      if (schema !== decisionSchemas.action && schema !== decisionSchemas.audit && schema !== decisionSchemas.equivalent) return { values: { [wheel.key]: '72 mm' } };
      if (schema === decisionSchemas.equivalent) return { equivalent: true };
      if (schema === decisionSchemas.audit) return { categoryMatches: true, fieldsMatch: true, photosPresent: true, questions: [], fields: [{ label: 'Title', value: f.draft.title, source: 'title' }] };
      const elements = v.page.elements;
      const action = (action: string, label = '', source = '', value = '') => ({ action, target: elements.find((e: any) => e.label === label)?.id || '', source, value, reason: 'fixture', questions: [] });
      for (const [label, source] of [['Title', 'title'], ['Description', 'description'], ['Price', 'price']]) if (!elements.find((e: any) => e.label === label)?.value) return action('fill', label, source);
      for (const field of [camera, wheel]) {
        if (!v.draft.facts[field.key]) return { ...action('blocked'), questions: [field] };
        if (elements.find((e: any) => e.label === field.label)?.value !== v.draft.facts[field.key]) return action('select', field.label, `facts.${field.key}`, v.draft.facts[field.key]);
      }
      if (!v.uploaded) return action('upload', 'Photos');
      return action('done');
    }) as typeof ask;
    await f.flow.prepareAI(f.draft);
    assert.ok(f.flow.specCache.get(f.draft.category)?.some(f => f.key === wheel.key));
    if (estimateMissing) {
      assert.equal(f.draft.state, 'ready'); assert.equal(f.store.get(f.draft.id).facts[wheel.key], '72 mm');
      assert.equal(await page.getByLabel(wheel.label).inputValue(), f.draft.facts[wheel.key]);
      assert.equal(await page.getByLabel(camera.label).inputValue(), 'dslr'); assert.equal(f.draft.facts[camera.key], 'DSLR');
      assert.equal(f.draft.detailSources?.[wheel.key], 'estimated');
    } else { assert.equal(f.draft.state, 'needs_input'); assert.equal(f.draft.questions[0].key, wheel.key); }
    assert.notEqual(f.draft.state, 'published');
  } finally { await browser.close(); rmSync(join(privateDir, 'photos', photo.id + '.jpg'), { force: true }); f.close(); }
});

test('live schema excludes core/account/transaction controls and disabled placeholder options', async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    f.flow.browser.page = page;
    await page.setContent('<label>Category<select><option>Cameras</option></select></label><label>Title<input></label><label>Phone<input></label><label>City<input></label><label>Promotion<input type="checkbox"></label><label>Camera type<select required><option disabled>Choose one</option><option>DSLR</option></select></label>');
    const fields = snapshotFields(await f.flow.browser.snapshot(page));
    assert.equal(fields.length, 1); assert.deepEqual(fields[0].options, ['DSLR']);
  } finally { await browser.close(); f.close(); }
});

test('custom dropdown schema reads asynchronously offered live options without selecting a value', async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    f.flow.browser.page = page;
    await page.setContent(`<div><label class="t">Camera type *</label></div><div class="sg-selectbox__control"><div class="sg-selectbox__placeholder">Choose</div><input role="combobox" onclick="setTimeout(()=>{document.getElementById('choices').innerHTML='<div role=option>DSLR</div><div role=option>Mirrorless</div>'},100)"></div><div id="choices"></div>`);
    const fields = await f.flow.readSpecFields(page, await f.flow.browser.snapshot(page));
    assert.deepEqual(fields[0].options, ['DSLR', 'Mirrorless']); assert.equal(fields[0].required, true);
    assert.equal(await page.getByRole('combobox').inputValue(), '');
  } finally { await browser.close(); f.close(); }
});

test('a removed cached select option refreshes the schema and leaves an inline question instead of submitting the stale value', async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    f.flow.browser.page = page;
    await page.setContent('<label>Camera type<select required><option value="">Choose</option><option>Mirrorless</option></select></label><button>Publish listing</button>');
    Object.assign(f.draft, { specFields: [camera], facts: { [camera.key]: 'DSLR' }, automation: { steps: [] } });
    f.flow.specCache.set(f.draft.category, [camera]);
    f.flow.brain = (async (schema: unknown, _instructions, input) => {
      if (schema === decisionSchemas.details) return { description: '', answers: [answer(camera.key, 'DSLR')] };
      const v = JSON.parse(input), e = v.page.elements.find((e: any) => e.label === camera.label);
      return v.draft.facts[camera.key] ? { action: 'select', target: e.id, source: `facts.${camera.key}`, value: 'DSLR', questions: [] } : { action: 'blocked', questions: [{ ...camera, options: ['Fabricated model option'] }] };
    }) as typeof ask;
    assert.equal(await f.flow.agent(page, f.draft, 'prepare', '', 8), null);
    assert.equal(f.draft.state, 'needs_input'); assert.equal(f.draft.facts[camera.key], undefined);
    assert.deepEqual(f.draft.questions[0].options, ['Mirrorless']);
    assert.deepEqual(f.flow.specCache.get(f.draft.category)?.[0].options, ['Mirrorless']);
    assert.equal(await page.getByLabel(camera.label).inputValue(), '');
  } finally { await browser.close(); f.close(); }
});

test('owner-only details require matching evidence and never turn Used into New or invent included accessories', async () => {
  const f = fixture();
  try {
    f.flow.brain = (async (schema: unknown) => schema === decisionSchemas.details ? { description: '', answers: [
      { ...answer('Condition', 'New', 'owner'), evidence: 'Used' },
      { ...answer('Included accessories', 'Charger', 'owner'), evidence: 'Used' },
    ] } : { equivalent: false }) as typeof ask;
    await fillDetails(f.flow, f.draft, [{ ...ownerFields[0], options: ['Used', 'New'] }, ownerFields[1]]);
    assert.deepEqual(f.draft.facts, {}); assert.equal(f.draft.questions.length, 2);
  } finally { f.close(); }
});

for (const reason of ['unsupported condition', 'different language']) test(`description rewrite retains original when verification finds ${reason}`, async () => {
  const f = fixture();
  try {
    const original = f.draft.description;
    f.flow.brain = (async (schema: unknown, instructions, input, _slot, _settings, _images, options) => {
      if (schema === decisionSchemas.details) return { description: reason === 'different language' ? 'მეორადი კამერა' : 'Perfect working order with charger and no defects.', answers: [] };
      assert.equal(schema, decisionSchemas.descriptionCheck); assert.equal(options?.lookup, undefined);
      assert.match(instructions, /same language/); assert.match(instructions, /explicitly supported by ownerText/);
      assert.equal(JSON.parse(input).originalDescription, original);
      return { sameLanguage: reason !== 'different language', factsSupported: reason !== 'unsupported condition' };
    }) as typeof ask;
    await fillDetails(f.flow, f.draft, [], true);
    assert.equal(f.draft.description, original); assert.equal(f.draft.originalDescription, undefined);
  } finally { f.close(); }
});


test('numeric spec estimates cannot return units or commentary that the live number input would reject', () => {
  const schema = estimateSchema([{ key: 'Megapixels', label: 'Megapixels', required: true, options: [], kind: 'spec', inputType: 'number' }]);
  assert.equal(schema.safeParse({ values: { Megapixels: '24.2' } }).success, true);
  assert.equal(schema.safeParse({ values: { Megapixels: '24.2 MP' } }).success, false);
});


test('visible associated labels replace raw ids and non-spec Nikon controls are excluded', async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await page.setContent(`<div><label for="mp">Resolution</label><input id="mp" name="Attr-text-47" value="24.2 MP"></div>
      <div><span id="sensor-title">Sensor format</span><input aria-labelledby="sensor-title" name="Attr-text-48" value="DX"></div>
      <div><h3>Lens</h3><div><input name="Attr-text-49" value="18-55mm"></div></div>
      <div><input name="Attr-text-50" placeholder="Mount"></div>
      <div><label>Product name<input name="Title_4" value="Nikon D3400"></label></div>
      <div><label>Seller<input name="User" value="ფოტოკამერა"></label></div>
      <div><label>Kind<input name="0" value="ციფრული სარკიანი ფოტოკამერა"></label></div>
      <div><label>Clip<input name="VideoURL"></label></div>
      <div><input name="Attr-text-999"></div><div><input></div>
      <label>Description<textarea></textarea></label><label>Price<input></label><label>Phone<input></label><label>City<input></label>`);
    const snapshot = await f.flow.browser.snapshot(page), fields = snapshotFields(snapshot);
    assert.deepEqual(fields.map(f => f.label), ['Resolution', 'Sensor format', 'Lens', 'Mount']);
    assert.deepEqual(fields.map(f => f.controlId), ['name:Attr-text-47', 'name:Attr-text-48', 'name:Attr-text-49', 'name:Attr-text-50']);
    assert.equal(snapshot.elements.find(e => e.controlId === 'name:Attr-text-999')?.label, '');
  } finally { await browser.close(); f.close(); }
});

test('detail filling uses a stable identifier before a duplicate or changed label, with label fallback', async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await page.setContent('<label>Resolution<input name="other"></label><label>Megapixels<input name="Attr-text-47"></label>');
    const field = { key: 'Resolution', label: 'Resolution', required: false, options: [], kind: 'spec' as const, controlId: 'name:Attr-text-47' };
    f.draft.specFields = [field]; f.draft.facts.Resolution = '24.2 MP';
    const snapshot = await f.flow.browser.snapshot(page);
    assert.equal(matchingControls(field, snapshot)[0].label, 'Megapixels');
    assert.equal(await f.flow.fillSavedDetails(page, snapshot, f.draft), 'filled');
    assert.equal(await page.locator('[name="Attr-text-47"]').inputValue(), '24.2 MP');
    assert.equal(await page.locator('[name="other"]').inputValue(), '');
    f.draft.facts.Resolution = '25 MP';
    await f.flow.step(page, snapshot, { action: 'fill', target: snapshot.elements.find(e => e.controlId === 'name:other')!.id, source: 'facts.Resolution', value: '25 MP', questions: [], reason: '' }, f.draft, 'prepare', '');
    assert.equal(await page.locator('[name="Attr-text-47"]').inputValue(), '25 MP');
    assert.equal(await page.locator('[name="other"]').inputValue(), '');
    assert.equal(matchingControls({ ...field, controlId: 'name:removed' }, snapshot)[0].controlId, 'name:other');
  } finally { await browser.close(); f.close(); }
});

for (const required of [false, true]) test(`unmatched ${required ? 'required detail asks inline by visible label' : 'optional detail is skipped with a short note'}`, async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    f.flow.browser.page = page;
    await page.setContent('<button>Publish listing</button>');
    const field = { ...camera, required, controlId: 'name:removed' };
    f.draft.specFields = [field]; f.draft.facts[field.key] = 'DSLR';
    await f.flow.fillSavedDetails(page, await f.flow.browser.snapshot(page), f.draft);
    if (required) {
      assert.equal(f.draft.state, 'needs_input'); assert.equal(f.draft.questions[0].label, 'Camera type');
      assert.match(f.draft.message, /Camera type/);
    } else {
      assert.deepEqual(f.draft.questions, []); assert.match(f.draft.message, /Skipped optional detail: Camera type/);
    }
    f.flow.brain = (async () => ({ description: '', answers: [] })) as typeof ask;
    await f.flow.reconcileDetails(f.draft, [field]);
    assert.equal(f.draft.questions.length, required ? 1 : 0);
  } finally { await browser.close(); f.close(); }
});

test('old category schemas are invalidated and Nikon cached answers migrate on prepare without retyping or submission', async () => {
  const f = fixture(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    f.flow.browser.page = page; f.flow.useAccount = async () => {};
    const bad = { key: 'Attr-text-47', label: 'Attr-text-47', required: false, options: [], kind: 'spec' as const };
    const unavailable = { ...bad, key: 'Battery cycles', label: 'Battery cycles' };
    const extras = ['Title_4', 'User', '0', 'VideoURL'].map(key => ({ ...bad, key, label: key }));
    Object.assign(f.draft, { state: 'blocked', specFields: [bad, unavailable, ...extras], facts: { 'Battery cycles': '1000', 'Attr-text-47': '24.2 MP', Title_4: 'Nikon D3400', User: 'ფოტოკამერა', '0': 'ციფრული სარკიანი ფოტოკამერა', VideoURL: '' } });
    writeFileSync(f.flow.specCache.file, JSON.stringify({ [JSON.stringify(f.draft.category)]: { at: Date.now(), fields: [bad] } }));
    assert.equal(new SpecCache(f.flow.specCache.file).get(f.draft.category), undefined);
    let submitted = 0;
    f.flow.auth.ensureSignedIn = async () => { await page.setContent('<label>Resolution<input name="Attr-text-47"></label><button onclick="window.submitted()">Publish listing</button>'); return true; };
    f.flow.brain = (async (schema: unknown) => {
      if (schema === decisionSchemas.details) return { description: '', answers: [] };
      if (schema === decisionSchemas.audit) return { categoryMatches: true, fieldsMatch: true, photosPresent: true, questions: [], fields: [{ label: 'Resolution', value: '24.2 MP', source: 'facts.Resolution' }] };
      return { action: 'done', questions: [] };
    }) as typeof ask;
    // Fixture upload marks the agent result; no final marketplace action is executed.
    const agent = f.flow.agent.bind(f.flow);
    f.flow.agent = async (...args) => { const result = await agent(...args); return result && { ...result, uploaded: true }; };
    await page.exposeFunction('submitted', () => { submitted++; });
    await f.flow.prepareAI(f.draft);
    assert.equal(f.draft.state, 'ready'); assert.equal(submitted, 0);
    assert.equal(await page.getByLabel('Resolution').inputValue(), '24.2 MP');
    assert.deepEqual(f.draft.facts, { Resolution: '24.2 MP' });
    assert.equal(f.draft.specSchemaVersion, specSchemaVersion);
    assert.equal(new SpecCache(f.flow.specCache.file).get(f.draft.category)?.[0].label, 'Resolution');
    assert.ok(f.draft.events.some(e => /Reading category fields/.test(e.message)));
    assert.equal(f.draft.title, 'Nikon D3400');
    assert.ok(f.draft.events.some(e => e.message === 'Skipped optional detail: Battery cycles.'));
    // Exercise the durable Publish retry through its guarded prepare path, replacing only final submission.
    f.flow.accounts.use = () => {};
    const settings = f.flow.settings.load(); settings.automation.publish = true; f.flow.settings.save(settings);
    f.flow.publish = async d => { assert.equal(d.state, 'ready'); submitted++; d.state = 'published'; };
    f.store.save(f.draft);
    await f.flow.run(f.draft.id, 'submit');
    assert.equal(submitted, 1); assert.equal(f.store.get(f.draft.id).state, 'published');
  } finally { await browser.close(); f.close(); }
});
