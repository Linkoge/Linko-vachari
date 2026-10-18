import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('typing and autosave continue during slow concurrent uploads; text and photos survive reload', async ({ page }, info) => {
  await page.goto('/'); await expect(page.locator('input[type=file]')).toBeEnabled();
  const id = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const revisions: number[] = [];
  await page.route(`**/api/drafts/${id}/photos`, async route => {
    revisions.push(Number(route.request().headers()['if-match']));
    await gate; await route.continue();
  });
  try {
    await page.locator('input[type=file]').setInputFiles('public/icons/icon-512.png');
    await expect(page.getByRole('progressbar')).toHaveCount(1);
    // A second selection joins the background work while the first is pending.
    await page.locator('input[type=file]').setInputFiles('public/icons/icon-192.png');
    await expect(page.getByRole('progressbar')).toHaveCount(2);
    await expect.poll(() => revisions.length).toBe(2);
    for (const label of ['Listing title', 'Asking price', 'Description', 'Listing account', 'City', 'Category path']) {
      await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
    }
    await page.getByLabel('Listing title').pressSequentially('Lamp typed during upload');
    await page.getByLabel('Asking price', { exact: true }).fill('125');
    await page.getByLabel('Description', { exact: true }).pressSequentially('Text saved before either photo finishes.');
    await page.getByLabel('Category path').fill('Lighting > Studio lamps');
    await expect(page.locator('.lean-publish span')).toHaveText('Saved');
    const during = await (await page.request.get(`/api/drafts/${id}`)).json();
    expect(during.title).toBe('Lamp typed during upload'); expect(during.photos).toHaveLength(0);
    await expect(page.locator('#publish-reason')).toHaveText('Uploading photos…');
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Find category', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Find category', exact: true })).toHaveAccessibleDescription('Uploading photos…');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath('typing-during-upload.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    release();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByAltText('Item photo 2')).toBeVisible();
    expect(revisions.length).toBeGreaterThan(2); // stale uploads were retried against the saved text revision
    const saved = await (await page.request.get(`/api/drafts/${id}`)).json();
    expect(saved.title).toBe(during.title); expect(saved.price).toBe('125'); expect(saved.description).toBe(during.description);
    expect(saved.category).toEqual(['Lighting', 'Studio lamps']); expect(saved.photos).toHaveLength(2);
    expect(new Set(saved.photos.map((p: { id: string }) => p.id)).size).toBe(2);
    await page.reload();
    await expect(page.getByLabel('Listing title')).toHaveValue(saved.title);
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue(saved.description);
    await expect(page.getByAltText('Item photo 2')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { release(); }
});

test('autosave rebases a photo committed before its slow upload response without losing newer typing', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('input[type=file]')).toBeEnabled();
  const id = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  let release!: () => void, committed!: () => void;
  const gate = new Promise<void>(r => { release = r; }), uploaded = new Promise<void>(r => { committed = r; });
  await page.route(`**/api/drafts/${id}/photos`, async route => {
    // Reconstruct multipart explicitly: Chromium's intercepted binary post data
    // is not reliable when forwarded through APIRequestContext.fetch.
    const response = await page.request.post(route.request().url(), {
      headers: { 'X-Linko-Request': '1', 'If-Match': route.request().headers()['if-match'] },
      multipart: { photos: { name: 'icon-192.png', mimeType: 'image/png', buffer: readFileSync('public/icons/icon-192.png') } },
    });
    expect(response.status(), await response.text()).toBe(200); committed();
    await gate; await route.fulfill({ response });
  });
  let releaseSave!: () => void, saving!: () => void, first = true;
  const saveGate = new Promise<void>(r => { releaseSave = r; }), saveStarted = new Promise<void>(r => { saving = r; });
  const statuses: number[] = [];
  await page.route(`**/api/drafts/${id}`, async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    if (first) { first = false; saving(); await saveGate; }
    const response = await route.fetch(); statuses.push(response.status()); await route.fulfill({ response });
  });
  try {
    await page.locator('input[type=file]').setInputFiles('public/icons/icon-192.png'); await uploaded;
    await page.getByLabel('Listing title').fill('First text'); await saveStarted;
    await page.getByLabel('Listing title').fill('Latest text during both requests');
    await page.getByLabel('Description', { exact: true }).fill('Keep this newer description too.');
    releaseSave();
    await expect(page.locator('.lean-publish span')).toHaveText('Saved');
    expect(statuses).toContain(409); expect(statuses).toContain(200);
    await expect(page.getByRole('progressbar')).toHaveCount(1);
    release(); await expect(page.getByRole('progressbar')).toHaveCount(0);
    const saved = await (await page.request.get(`/api/drafts/${id}`)).json();
    expect(saved.title).toBe('Latest text during both requests'); expect(saved.description).toBe('Keep this newer description too.'); expect(saved.photos).toHaveLength(1);
    await page.reload(); await expect(page.getByLabel('Listing title')).toHaveValue(saved.title);
    await expect(page.getByAltText('Item photo 1')).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { releaseSave(); release(); }
});

test('failed background upload leaves typed text saved and removes pending progress', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('input[type=file]')).toBeEnabled();
  let attempts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/photos')) attempts++; });
  await page.locator('input[type=file]').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('invalid') });
  await expect(page.getByRole('alert')).toContainText('Choose a single JPEG');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  expect(attempts).toBe(1);
  await expect(page.getByRole('button', { name: 'Reload saved draft' })).toHaveCount(0);
  await page.getByLabel('Listing title').fill('Still editable after upload failure');
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  const id = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  expect((await (await page.request.get(`/api/drafts/${id}`)).json()).title).toBe('Still editable after upload failure');
});

test('background upload reconciliation never overwrites another device’s conflicting text', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('input[type=file]')).toBeEnabled();
  const id = await page.evaluate(() => sessionStorage.getItem('linko-draft'));
  const original = await (await page.request.get(`/api/drafts/${id}`)).json();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  await page.route(`**/api/drafts/${id}/photos`, async route => { await gate; await route.continue(); });
  try {
    await page.locator('input[type=file]').setInputFiles('public/icons/icon-192.png');
    await expect(page.getByRole('progressbar')).toHaveCount(1);
    const remote = await page.request.patch(`/api/drafts/${id}`, {
      headers: { 'X-Linko-Request': '1' }, data: { ...original, title: 'Saved by another device' },
    });
    expect(remote.status()).toBe(200);
    await page.getByLabel('Listing title').fill('Local unsaved title');
    await expect(page.getByRole('button', { name: 'Reload saved draft' })).toBeVisible();
    release(); await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByLabel('Listing title')).toHaveValue('Local unsaved title');
    expect((await (await page.request.get(`/api/drafts/${id}`)).json()).title).toBe('Saved by another device');
    await page.getByRole('button', { name: 'Reload saved draft' }).click();
    await expect(page.getByLabel('Listing title')).toHaveValue('Saved by another device');
  } finally { release(); }
});
