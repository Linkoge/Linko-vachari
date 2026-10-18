import { test, expect } from '@playwright/test';

test('one-page editor autosaves text, photos, cover and order; drafts resume and delete', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'New listing', exact: true })).toBeVisible();
  await expect(page.locator('input[type=file]')).toBeEnabled();
  await page.screenshot({ path: info.outputPath('editor-overview.png'), fullPage: true });
  for (const name of ['Listing title', 'Asking price', 'Description', 'Listing account', 'Category path']) await expect(page.getByLabel(name, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find category', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
  await expect(page.getByText(/You're in control|you are protected|Check live listing form|Review & list/i)).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles(['public/icons/icon-512.png', 'public/icons/icon-192.png']);
  await expect(page.getByAltText('Item photo 2')).toBeVisible();
  const uploadedId = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  const secondPhoto = (await (await page.request.get('/api/drafts/' + uploadedId)).json()).photos[1].id;
  await page.getByRole('button', { name: 'Use photo 2 as cover' }).click();
  await page.getByRole('button', { name: 'Move photo 2 earlier' }).click();
  await expect(page.getByRole('button', { name: 'Use photo 1 as cover' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Listing title').fill('Studio lamp');
  await page.getByLabel('Asking price', { exact: true }).fill('125');
  await page.getByLabel('Description', { exact: true }).fill('A used lamp with the original stand.');
  await page.getByLabel('Category path').pressSequentially('Home > Lighting > Lamps', { delay: 15 });
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  const id = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  const saved = await (await page.request.get('/api/drafts/' + id)).json();
  expect(saved.category).toEqual(['Home', 'Lighting', 'Lamps']); expect(saved.photos).toHaveLength(2); expect(saved.coverId).toBe(secondPhoto); expect(saved.photos[0].id).toBe(secondPhoto);
  await page.reload(); await expect(page.getByLabel('Listing title')).toHaveValue('Studio lamp');
  await expect.poll(() => page.getByAltText('Item photo 1').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(192);
  await expect(page.getByRole('button', { name: 'Use photo 1 as cover' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Find category', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Codex could not complete', { timeout: 20000 });
  await page.getByRole('button', { name: 'New draft', exact: true }).click();
  await expect(page.getByLabel('Listing title')).toHaveValue('');
  await page.getByRole('button', { name: 'Drafts', exact: true }).click();
  await page.getByRole('button', { name: 'Resume Studio lamp', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('A used lamp with the original stand.');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.lean-editor').screenshot({ path: info.outputPath('editor-mobile.png') });
  await page.getByRole('button', { name: 'Drafts', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Studio lamp', exact: true }).click();
  await page.getByRole('button', { name: 'New listing', exact: true }).click();
  await expect(page.getByLabel('Listing title')).toHaveValue('');
  expect((await page.request.get('/api/drafts/' + id)).status()).toBe(404); expect(errors).toEqual([]);
});

test('offline edits persist per tab and autosave after reconnect; service worker excludes private APIs', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto('/');
  await expect(page.locator('input[type=file]')).toBeEnabled();
  await page.getByLabel('Description', { exact: true }).fill('Saved online');
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.waitForTimeout(700); await context.setOffline(true);
  await page.getByLabel('Description', { exact: true }).fill('Edited while offline');
  await expect(page.getByText('Saved on this device')).toBeVisible();
  await page.waitForTimeout(300); await page.reload();
  await expect(page.getByText('Offline mode', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Edited while offline');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async k => (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname)))).flat().some(p => p.startsWith('/api/')))).toBe(false);
  await context.setOffline(false);
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  const id = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  expect((await (await page.request.get('/api/drafts/' + id)).json()).description).toBe('Edited while offline');
});

test('tabs create independent drafts and edits typed during autosave are preserved', async ({ page, context }) => {
  await page.goto('/'); await expect(page.locator('input[type=file]')).toBeEnabled();
  const [second] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => { window.open('/', '_blank'); })]);
  await second.waitForLoadState(); await expect(second.locator('input[type=file]')).toBeEnabled();
  const firstId = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  const secondId = await second.evaluate(() => sessionStorage.getItem('linko-draft')); expect(firstId).not.toBe(secondId);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
  let intercepted = false;
  await page.route('**/api/drafts/' + firstId, async route => {
    if (route.request().method() === 'PATCH' && !intercepted) { intercepted = true; started(); await gate; }
    await route.continue();
  });
  await page.getByLabel('Listing title').fill('First version'); await began;
  await page.getByLabel('Listing title').fill('Newest version');
  await second.getByLabel('Listing title').fill('Other tab');
  release(); await expect(page.locator('.lean-publish span')).toHaveText('Saved'); await expect(second.locator('.lean-publish span')).toHaveText('Saved');
  expect((await (await page.request.get('/api/drafts/' + firstId)).json()).title).toBe('Newest version');
  expect((await (await page.request.get('/api/drafts/' + secondId)).json()).title).toBe('Other tab');
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>(r => { releaseLoad = r; });
  await page.route('**/api/drafts/' + firstId, async route => { if (route.request().method() === 'GET') await loadGate; await route.continue(); });
  await page.reload();
  await expect(page.getByLabel('Listing title')).toBeDisabled();
  releaseLoad(); await second.reload();
  await expect(page.getByLabel('Listing title')).toHaveValue('Newest version'); await expect(second.getByLabel('Listing title')).toHaveValue('Other tab');
  await second.close();
});

test('Publish queues once and immediately clears the editor, with job status in listings and missing facts inline', async ({ page }) => {
  let published = 0, oldId = '';
  await page.route('**/api/config', r => r.fulfill({ json: { publishEnabled: true, mode: 'local' } }));
  await page.route('**/api/drafts/*/publish', async route => {
    published++; oldId = route.request().url().split('/').at(-2)!;
    const nextDraft = await (await page.request.post('/api/drafts', { headers: { 'X-Linko-Request': '1' }, data: {} })).json();
    await route.fulfill({ status: 202, json: { accepted: true, nextDraft, job: { status: 'queued' } } });
  });
  await page.route('**/api/listings', r => r.fulfill({ json: { listings: published ? [{ id: oldId, title: 'Queued lamp', price: '25', currency: 'GEL', account: 'Personal', status: 'failed', canDelete: false }] : [] } }));
  await page.goto('/'); await expect(page.locator('input[type=file]')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles('public/icons/icon-192.png'); await expect(page.getByAltText('Item photo 1')).toBeVisible();
  await page.getByLabel('Listing title').fill('Queued lamp'); await page.getByLabel('Asking price', { exact: true }).fill('25'); await page.getByLabel('Description', { exact: true }).fill('Used lamp');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByLabel('Listing title')).toHaveValue(''); await expect(page.getByAltText('Item photo 1')).toHaveCount(0);
  await expect(page.getByLabel('Asking price', { exact: true })).toHaveValue(''); await expect(page.getByLabel('Description', { exact: true })).toHaveValue('');
  expect(published).toBe(1); expect(await page.evaluate(() => sessionStorage.getItem('linko-draft'))).not.toBe(oldId);
  await page.getByRole('button', { name: 'My listings', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Queued lamp' })).toContainText('failed');
  await expect(page.getByRole('button', { name: 'Open draft' })).toHaveCount(0);
  await page.route('**/api/drafts/' + oldId, async r => {
    const d = await (await r.fetch()).json(); await r.fulfill({ json: { ...d, state: 'needs_input', questions: [{ key: 'Power', label: 'Power source', options: ['Mains', 'Battery'] }] } });
  });
  await page.getByRole('button', { name: 'Drafts', exact: true }).click();
  await page.getByRole('button', { name: 'Resume Queued lamp', exact: true }).click();
  await expect(page.getByLabel('Power source', { exact: true })).toBeVisible(); await page.getByLabel('Power source', { exact: true }).selectOption('Mains');
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  expect((await (await page.request.get('/api/drafts/' + oldId)).json()).facts.Power).toBe('Mains');
});
