import { test, expect } from '@playwright/test';

test('saved listings expose records, pause/resume and the original draft', async ({ page, request }, testInfo) => {
  const created = await request.post('/api/drafts', { headers: { 'X-Linko-Request': '1' }, data: {} });
  const draft = await created.json();
  const record = { id: draft.id, title: 'Saved studio lamp', enabled: true, status: 'active', message: 'Public listing verified.', checkedAt: Date.now(), receipt: { url: 'https://mymarket.ge/pr/900/lamp' } };
  await page.route('**/api/listings', route => route.fulfill({ json: { autoRelistEnabled: true, records: [record] } }));
  await page.route('**/api/listings/' + draft.id, route => {
    expect(route.request().headers()['x-linko-request']).toBe('1');
    record.enabled = route.request().postDataJSON().enabled;
    return route.fulfill({ json: record });
  });
  await page.goto('/');
  await page.getByText('Saved listings · 1', { exact: true }).click();
  const records = page.getByRole('region', { name: 'Saved listings' });
  await expect(records.getByRole('heading', { name: 'Saved studio lamp' })).toBeVisible();
  await expect(records.getByText(/Pause monitoring before selling/)).toBeVisible();
  await expect(records.getByRole('link', { name: 'Download Markdown record' })).toHaveAttribute('href', `/api/listings/${draft.id}/record`);
  await records.getByRole('button', { name: 'Pause monitoring' }).click();
  await expect(records.getByRole('button', { name: 'Resume monitoring' })).toBeVisible();
  await records.getByRole('button', { name: 'Resume monitoring' }).click();
  await expect(records.getByRole('button', { name: 'Pause monitoring' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-listings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await records.screenshot({ path: testInfo.outputPath('saved-listings-mobile.png') });
  await records.getByRole('button', { name: 'Open draft' }).click();
  await expect(page.getByRole('textbox', { name: 'Listing title' })).toBeVisible();
});
