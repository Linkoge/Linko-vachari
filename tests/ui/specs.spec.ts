import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('Find category displays filled live specs, editable provenance, required unknowns, description undo and remembered estimate choice', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const headers = { 'X-Linko-Request': '1' };
  await page.request.post('/api/settings/accounts', { headers, data: { label: 'Camera account', identifier: 'camera@x.io', password: randomUUID() } });
  let draft = await (await page.request.post('/api/drafts', { headers, data: {} })).json();
  draft = await (await page.request.post(`/api/drafts/${draft.id}/photos`, { headers, multipart: { photos: { name: 'cover.png', mimeType: 'image/png', buffer: await (await page.request.get('/icons/icon-192.png')).body() } } })).json();
  const path = '/api/drafts/' + draft.id;
  draft = await (await page.request.patch(path, { headers, data: { revision: draft.revision, title: 'Nikon D3400', description: 'Used camera with strap.', price: '250', currency: 'GEL', model: 'D3400', condition: '', location: 'თბილისი', category: [], facts: {}, coverId: draft.coverId } })).json();
  const original = draft.description, improved = 'Used Nikon D3400 DSLR camera with a 24.2 MP DX sensor. Strap included.';
  const fields = [
    { key: 'Camera type', label: 'Camera type', required: true, kind: 'spec', options: ['DSLR', 'Mirrorless'] },
    { key: 'Megapixels', label: 'Megapixels', required: false, kind: 'spec', options: [] },
    { key: 'Size', label: 'Size', required: true, kind: 'spec', options: ['Small', 'Large'] },
  ];
  let analyzed = false;
  await page.route('**' + path + '/analyze', async r => { analyzed = true; await r.fulfill({ status: 202, json: { accepted: true } }); });
  await page.route('**' + path, async route => {
    const response = await route.fetch();
    const saved = await response.json();
    if (analyzed && route.request().method() === 'GET') {
      await route.fulfill({ response, json: { ...saved, state: 'needs_input', category: ['Electronics', 'Cameras'], specFields: fields, facts: { 'Camera type': 'DSLR', Megapixels: '24.2' }, detailSources: { 'Camera type': 'lookup', Megapixels: 'lookup' }, originalDescription: original, description: improved, descriptionRewritten: true, questions: [{ key: 'Size', label: 'Size', options: ['Small', 'Large'] }] } });
    } else await route.fulfill({ response });
  });
  await page.goto('/#draft/' + draft.id);
  await page.getByRole('button', { name: 'Find category', exact: true }).click();
  await expect(page.getByLabel('Camera type', { exact: true })).toHaveValue('DSLR');
  await expect(page.getByLabel('Megapixels', { exact: true })).toHaveValue('24.2');
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(improved);
  await expect(page.locator('.missing-detail')).toContainText('Size');
  await expect(page.getByText('AI · looked up').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('camera-details-mobile.png'), fullPage: true });
  // Subsequent saves go to the real draft API. The fixture pins the discovered schema in its response.
  analyzed = false;
  await page.getByLabel('Camera type', { exact: true }).selectOption('Mirrorless');
  await page.getByLabel('Size', { exact: true }).selectOption('Small');
  await page.getByRole('button', { name: 'Undo description improvement' }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(original);
  await expect(page.getByRole('button', { name: 'Undo description improvement' })).toHaveCount(0);
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  const saved = await (await page.request.get(path)).json();
  expect(saved.description).toBe(original); expect(saved.facts['Camera type']).toBe('Mirrorless'); expect(saved.facts.Size).toBe('Small');
  await page.route('**' + path + '/details', r => r.fulfill({ status: 202, json: { accepted: true } }));
  await page.getByLabel('Estimate missing details', { exact: true }).check();
  await expect.poll(async () => (await (await page.request.get(path)).json()).estimateMissing).toBe(true);
  await page.getByRole('button', { name: 'New draft', exact: true }).click();
  await expect(page.getByLabel('Estimate missing details', { exact: true })).toBeChecked();
  await page.getByLabel('Estimate missing details', { exact: true }).uncheck();
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New draft', exact: true }).click();
  await expect(page.getByLabel('Estimate missing details', { exact: true })).not.toBeChecked();
});

test('estimated values have a distinct editable marker and only unknown required values are highlighted', async ({ page }, info) => {
  const headers = { 'X-Linko-Request': '1' };
  const draft = await (await page.request.post('/api/drafts', { headers, data: {} })).json();
  await page.route('**/api/drafts/' + draft.id, async r => {
    const response = await r.fetch(), saved = await response.json();
    await r.fulfill({ response, json: { ...saved, estimateMissing: true, specFields: [
      { key: 'Wheel diameter', label: 'Wheel diameter', required: true, kind: 'spec', options: ['64 mm', '72 mm', '80 mm'] },
      { key: 'Included', label: 'Included accessories', required: true, kind: 'owner', options: [] },
      { key: 'Attr-text-47', label: 'Attr-text-47', required: false, kind: 'spec', options: [] },
    ], facts: { 'Wheel diameter': '72 mm' }, detailSources: { 'Wheel diameter': 'estimated' } } });
  });
  await page.goto('/#draft/' + draft.id);
  await expect(page.getByLabel('Wheel diameter', { exact: true })).toHaveValue('72 mm');
  await expect(page.getByText('estimated', { exact: true })).toBeVisible();
  await expect(page.getByText('Attr-text-47', { exact: true })).toHaveCount(0);
  await expect(page.locator('.missing-detail')).toHaveCount(1);
  await expect(page.locator('.missing-detail')).toContainText('Included accessories');
  await page.screenshot({ path: info.outputPath('estimated-details-desktop.png'), fullPage: true });
  await page.getByLabel('Wheel diameter', { exact: true }).selectOption('80 mm');
  await expect(page.getByText('estimated', { exact: true })).toHaveCount(0);
});


test('background jobs refresh an already open idle draft with progress and results; polling protects unsaved edits', async ({ page }) => {
  const draft = await (await page.request.post('/api/drafts', { headers: { 'X-Linko-Request': '1' }, data: {} })).json();
  const path = '/api/drafts/' + draft.id;
  let phase = 'idle';
  await page.route('**' + path, async r => {
    const response = await r.fetch(), saved = await response.json();
    if (r.request().method() === 'GET' && phase !== 'idle') {
      await r.fulfill({ response, json: { ...saved, state: phase === 'finished' ? 'review' : 'preparing', message: phase === 'reading' ? 'Reading category fields…' : 'Looking up specs…', specFields: [{ key: 'Sensor', label: 'Sensor format', required: false, options: [], kind: 'spec' }], facts: { Sensor: phase === 'finished' ? 'DX' : '' } } });
    } else await r.fulfill({ response });
  });
  await page.goto('/#draft/' + draft.id);
  await expect(page.getByLabel('Listing title')).toBeEnabled();
  phase = 'reading'; await expect(page.getByRole('status')).toHaveText('Reading category fields…');
  phase = 'lookup'; await expect(page.getByRole('status')).toHaveText('Looking up specs…');
  phase = 'finished'; await expect(page.getByLabel('Sensor format', { exact: true })).toHaveValue('DX');
  await expect(page.getByLabel('Listing title')).toBeEnabled();
  // Hold a save while the poll has an older server title available.
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  await page.route('**' + path, async r => {
    if (r.request().method() === 'PATCH') { await hold; await r.continue(); }
    else await r.fallback();
  });
  await page.getByLabel('Listing title').fill('Owner edit while polling');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toContainText('Saving…');
  await page.waitForTimeout(1200);
  await expect(page.getByLabel('Listing title')).toHaveValue('Owner edit while polling');
  release();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toContainText('Saved');
});

test('Save draft explicitly persists text with saving state, and draft rows and Open both resume the editor', async ({ page }) => {
  await page.goto('/');
  const title = page.getByLabel('Listing title');
  await expect(title).toBeEnabled();
  const id = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  await page.route('**/api/drafts/' + id, async r => {
    if (r.request().method() === 'PATCH') { await hold; await r.continue(); }
    else await r.continue();
  });
  await title.fill('Saved camera');
  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await save.click(); await expect(save).toContainText('Saving…'); await expect(save).toBeDisabled();
  release(); await expect(save).toContainText('Saved'); await expect(save).toBeEnabled();
  expect((await (await page.request.get('/api/drafts/' + id)).json()).title).toBe('Saved camera');
  await page.getByRole('button', { name: 'Drafts', exact: true }).click();
  await page.getByRole('article', { name: 'Saved camera', exact: true }).getByText('Saved camera', { exact: true }).click();
  await expect(title).toHaveValue('Saved camera');
  expect(await page.evaluate(() => sessionStorage.getItem('linko-draft'))).toBe(id);
  await page.getByRole('button', { name: 'Drafts', exact: true }).click();
  await page.getByRole('button', { name: 'Open Saved camera', exact: true }).click();
  await expect(title).toHaveValue('Saved camera');
});
