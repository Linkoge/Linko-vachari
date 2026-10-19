import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('New/Used toggle is saved and remembered; a running job shows a spinner with its step; Publish stays available during a job', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const headers = { 'X-Linko-Request': '1' };
  await page.request.post('/api/settings/accounts', { headers, data: { label: 'Progress account', identifier: 'progress@x.io', password: randomUUID() } });
  let draft = await (await page.request.post('/api/drafts', { headers, data: {} })).json();
  draft = await (await page.request.post(`/api/drafts/${draft.id}/photos`, { headers, multipart: { photos: { name: 'cover.png', mimeType: 'image/png', buffer: await (await page.request.get('/icons/icon-192.png')).body() } } })).json();
  const path = '/api/drafts/' + draft.id;
  let step = ''; // non-empty => the draft is reported as running that step
  await page.route('**' + path, async route => {
    const response = await route.fetch();
    if (route.request().method() !== 'GET' || !step) return route.fulfill({ response });
    await route.fulfill({ response, json: { ...(await response.json()), state: 'analyzing', step, message: 'Working' } });
  });
  await page.route('**/api/config', r => r.fulfill({ json: { publishEnabled: true, mode: 'local' } }));
  let listingStep = 'Reading fields…';
  await page.route('**/api/listings', r => r.fulfill({ json: { listings: [{ id: draft.id, title: 'Skates', price: '40', currency: 'GEL', account: 'Progress account', status: 'preparing', progress: listingStep, canDelete: false }] } }));
  let publishes = 0;
  await page.route('**' + path + '/publish', async r => {
    publishes++;
    const nextDraft = await (await page.request.post('/api/drafts', { headers, data: {} })).json();
    await r.fulfill({ status: 202, json: { accepted: true, nextDraft, job: { status: 'running' } } });
  });
  await page.goto('/#draft/' + draft.id);
  await expect(page.getByAltText('Item photo 1')).toBeVisible();
  await page.getByLabel('Listing title').fill('Skates'); await page.getByLabel('Asking price', { exact: true }).fill('40'); await page.getByLabel('Description', { exact: true }).fill('Fast skates');

  // Two-choice segmented control, single tap, no dropdown.
  const toggle = page.getByRole('group', { name: 'Condition' });
  await expect(toggle.getByRole('button')).toHaveText(['New', 'Used']);
  await expect(toggle.getByRole('button', { pressed: true })).toHaveCount(0);
  await toggle.getByRole('button', { name: 'Used' }).click();
  await expect(toggle.getByRole('button', { name: 'Used' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await (await page.request.get(path)).json()).condition).toBe('used');
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  await page.screenshot({ path: info.outputPath('condition-toggle.png'), fullPage: true });

  // While a job runs: animated indicator with the step, updating without refresh, and Publish still accepted.
  step = 'Finding category…';
  const status = page.locator('.lean-editor .job-progress');
  await expect(status).toHaveText('Finding category…'); await expect(status.locator('.spinner')).toBeVisible();
  expect(await status.locator('.spinner').evaluate(e => getComputedStyle(e).animationName)).toBe('linko-spin');
  step = 'Looking up specs…'; await expect(status).toHaveText('Looking up specs…');
  step = 'Filling form…'; await expect(status).toHaveText('Filling form…');
  await page.screenshot({ path: info.outputPath('running-step.png'), fullPage: true });
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
  await expect(page.locator('#publish-reason')).toHaveCount(0);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect.poll(() => publishes).toBe(1);
  await expect(page.getByRole('heading', { name: 'My listings', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const row = page.getByRole('article', { name: 'Skates' });
  await expect(row.locator('.listing-progress')).toHaveText('Reading fields…'); await expect(row.locator('.spinner')).toBeVisible();
  listingStep = 'Publishing…'; await expect(row.locator('.listing-progress')).toHaveText('Publishing…');
  await page.screenshot({ path: info.outputPath('my-listings-progress.png'), fullPage: true });

  // The next listing starts with the remembered choice.
  step = ''; await page.getByRole('button', { name: 'New listing', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Condition' }).getByRole('button', { name: 'Used' })).toHaveAttribute('aria-pressed', 'true');
});
