import { test, expect } from '@playwright/test';
import { randomUUID, randomInt } from 'node:crypto';

test('Needs info links to inline questions, saves account answers and publishes the answered draft', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const headers = { 'X-Linko-Request': '1' };
  await page.request.post('/api/settings/accounts', { headers, data: { label: 'Info account', identifier: 'info@x.io', password: randomUUID() } });
  let draft = await (await page.request.post('/api/drafts', { headers, data: {} })).json();
  const uploaded = await page.request.post(`/api/drafts/${draft.id}/photos`, { headers, multipart: { photos: { name: 'cover.png', mimeType: 'image/png', buffer: await (await page.request.get('/icons/icon-192.png')).body() } } });
  draft = await uploaded.json();
  const path = '/api/drafts/' + draft.id;
  draft = await (await page.request.patch(path, { headers, data: { accountId: draft.accountId, revision: draft.revision, title: 'nikon D3400', description: 'Used camera', price: '100', currency: 'GEL', model: '', condition: '', location: '', category: ['Cameras'], facts: {}, coverId: draft.coverId } })).json();
  const questions = [{ key: 'Power', label: 'Power source', options: ['Battery', 'Mains'] }, { key: 'Included', label: 'Included accessories', options: [] }, { key: 'city', label: 'ქალაქი/ზუსტი მდებარეობა *', options: ['თბილისი', 'ბათუმი'] }, { key: 'mobile', label: 'მობილურის ნომერი *', options: [] }];
  await page.route('**' + path, async route => {
    const response = await route.fetch(); const saved = await response.json();
    await route.fulfill({ response, json: { ...saved, state: 'needs_input', questions, message: 'Required details from MyMarket.' } });
  });
  await page.route('**/api/config', r => r.fulfill({ json: { publishEnabled: true, mode: 'local' } }));
  await page.route('**/api/listings', r => r.fulfill({ json: { listings: [
    { id: draft.id, draftId: draft.id, title: 'nikon D3400', price: '100', currency: 'GEL', account: 'Info account', status: 'needs_input', reason: 'Required: city, mobile phone, power source', canDelete: false },
    { id: 'failed', title: 'Failed camera', price: '100', currency: 'GEL', account: 'Info account', status: 'failed', reason: 'MyMarket did not accept the selected category.', canDelete: false },
  ] } }));
  let publishes = 0;
  await page.route('**' + path + '/publish', async r => {
    const saved = await (await page.request.get(path)).json();
    expect(saved.facts.Power).toBe('Battery'); expect(saved.facts.Included).toBe('Strap'); expect(saved.location).toBe('ბათუმი');
    expect(r.request().postDataJSON().revision).toBe(saved.revision);
    publishes++;
    const nextDraft = await (await page.request.post('/api/drafts', { headers, data: {} })).json();
    await r.fulfill({ status: 202, json: { accepted: true, nextDraft } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'My listings', exact: true }).click();
  const row = page.getByRole('article', { name: 'nikon D3400', exact: true });
  await expect(row.getByText('Needs info', { exact: true })).toBeVisible();
  await expect(row.getByText('failed', { exact: true })).toHaveCount(0);
  await expect(row).toContainText('Required: city, mobile phone');
  await expect(page.getByRole('article', { name: 'Failed camera', exact: true })).toContainText('MyMarket did not accept');
  await page.screenshot({ path: info.outputPath('needs-info-history.png'), fullPage: true });
  await row.getByRole('link', { name: 'Open draft' }).click();
  await expect(page.getByLabel('Listing title')).toHaveValue('nikon D3400');
  await page.goto('/#draft/' + draft.id); // The same link also works when copied or opened in a new tab.
  await expect(page.getByLabel('Listing title')).toHaveValue('nikon D3400');
  await expect(page.getByLabel('City', { exact: true })).toHaveValue('თბილისი');
  await page.getByLabel('Power source').selectOption('Battery');
  await page.getByLabel('Included accessories').fill('Strap');
  await page.getByLabel(questions[2].label, { exact: true }).selectOption('ბათუმი');
  await page.getByRole('button', { name: 'Save as account default city' }).click();
  const phone = '5' + randomInt(10_000_000, 99_999_999);
  await page.getByLabel(questions[3].label, { exact: true }).fill(phone);
  await page.getByRole('button', { name: 'Save as account default phone' }).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  const cached = await page.evaluate(id => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open('linko-private-draft', 1);
    request.onsuccess = () => { const db = request.result, read = db.transaction('workspace').objectStore('workspace').get(id); read.onsuccess = () => { db.close(); resolve(JSON.stringify(read.result)); }; read.onerror = () => reject(read.error); };
    request.onerror = () => reject(request.error);
  }), draft.id);
  expect(cached).not.toContain(phone);
  const account = (await (await page.request.get('/api/accounts')).json()).accounts.find((a: { id: string }) => a.id === draft.accountId);
  expect(account.defaults).toEqual({ location: 'ბათუმი', phone });
  // Keep screenshots free of even runtime-generated contact values.
  await page.getByLabel(questions[3].label, { exact: true }).fill('');
  await page.screenshot({ path: info.outputPath('inline-required-info.png'), fullPage: true });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect.poll(() => publishes).toBe(1);
  await expect(page.getByLabel('Listing title')).toHaveValue('');
  await expect(page.getByLabel('City', { exact: true })).toHaveValue('ბათუმი');
});
