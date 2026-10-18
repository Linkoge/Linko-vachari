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
    ], facts: { 'Wheel diameter': '72 mm' }, detailSources: { 'Wheel diameter': 'estimated' } } });
  });
  await page.goto('/#draft/' + draft.id);
  await expect(page.getByLabel('Wheel diameter', { exact: true })).toHaveValue('72 mm');
  await expect(page.getByText('estimated', { exact: true })).toBeVisible();
  await expect(page.locator('.missing-detail')).toHaveCount(1);
  await expect(page.locator('.missing-detail')).toContainText('Included accessories');
  await page.screenshot({ path: info.outputPath('estimated-details-desktop.png'), fullPage: true });
  await page.getByLabel('Wheel diameter', { exact: true }).selectOption('80 mm');
  await expect(page.getByText('estimated', { exact: true })).toHaveCount(0);
});
