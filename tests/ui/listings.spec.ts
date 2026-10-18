import { test, expect } from '@playwright/test';

for (const width of [1360, 390, 320]) {
  test(`four-section navigation and My listings deletion at ${width}px`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const listings = ['queued', 'publishing', 'live', 'failed', 'deleted-by-me', 'relisted'].map((status, i) => ({
      id: `listing-${i}`, title: `Studio lamp ${i}`, price: '125', currency: 'GEL', account: i % 2 ? 'Shop' : 'Personal', status,
      cover: '/icons/icon-192.png', url: ['queued', 'publishing', 'failed'].includes(status) ? undefined : `https://mymarket.ge/pr/90${i}/lamp`,
      canDelete: ['queued', 'live'].includes(status),
    }));
    await page.route('**/api/listings', r => r.fulfill({ json: { listings } }));
    let deletes = 0;
    await page.route('**/api/listings/*/delete', route => {
      expect(route.request().headers()['x-linko-request']).toBe('1'); expect(route.request().postDataJSON()).toEqual({ confirm: true });
      const item = listings.find(l => l.id === route.request().url().split('/').at(-2))!;
      deletes++; item.status = 'deleted-by-me'; item.canDelete = false;
      return route.fulfill({ json: { status: 'deleted_by_owner', deleteRequestedAt: Date.now() } });
    });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('button')).toHaveText(['New listing', 'Drafts', 'My listings', 'Settings']);
    await expect(page.getByRole('region', { name: 'Drafts', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'My listings', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`overview-${width}.png`), fullPage: true });
    await nav.getByRole('button', { name: 'My listings', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'My listings', exact: true })).toHaveAttribute('aria-current', 'page');
    const records = page.getByRole('region', { name: 'My listings', exact: true });
    await expect(records.getByRole('article')).toHaveCount(6);
    await expect(page.getByRole('textbox', { name: 'Listing title' })).toHaveCount(0);
    await expect(records.getByRole('button', { name: /edit|open draft|monitoring/i })).toHaveCount(0);
    await expect(records.getByRole('link', { name: /Markdown/ })).toHaveCount(0);
    for (const item of listings) {
      const row = records.getByRole('article', { name: item.title, exact: true });
      await expect(row.getByRole('heading')).toHaveText(item.title); await expect(row).toContainText('125 GEL'); await expect(row).toContainText(item.account);
      await expect(row.getByText(item.status, { exact: true })).toBeVisible();
      await expect(row.getByRole('img', { name: 'Cover of ' + item.title })).toBeVisible();
      if (item.url) await expect(row.getByRole('link', { name: 'MyMarket', exact: true })).toHaveAttribute('href', item.url);
      if (!item.canDelete) await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await records.screenshot({ path: info.outputPath(`my-listings-${width}.png`) });
    const live = records.getByRole('article', { name: 'Studio lamp 2', exact: true });
    await live.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Studio lamp 2?' }); await expect(dialog).toBeVisible();
    expect(deletes).toBe(0); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(deletes).toBe(0);
    await expect(live.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await live.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await expect(live.getByText('deleted-by-me', { exact: true })).toBeVisible(); expect(deletes).toBe(1);
    await expect(live.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    const queued = records.getByRole('article', { name: 'Studio lamp 0', exact: true });
    await queued.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Cancel publication');
    await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await expect(queued).toContainText('deleted-by-me'); expect(deletes).toBe(2);
    await context.setOffline(true);
    await expect(records.getByRole('button', { name: 'Delete', exact: true }).first()).toBeDisabled();
    await context.setOffline(false);
    await nav.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(records).toHaveCount(0);
    await nav.getByRole('button', { name: 'Drafts', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Drafts', exact: true })).toBeVisible();
  });
}

test('My listings is visible before the first publication, and failed deletes keep the row', async ({ page }) => {
  let listings: unknown[] = [];
  await page.route('**/api/listings', r => r.fulfill({ json: { listings } }));
  await page.goto('/'); await page.getByRole('button', { name: 'My listings', exact: true }).click();
  await expect(page.getByText('No listings yet.', { exact: true })).toBeVisible();
  listings = [{ id: 'live', title: 'Lamp', price: '25', currency: 'USD', account: 'Shop', status: 'live', url: 'https://mymarket.ge/pr/900/lamp', canDelete: true }];
  await page.route('**/api/listings/live/delete', r => r.fulfill({ status: 409, json: { message: 'Finish the current browser task.' } }));
  await page.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Finish the current browser task.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Lamp', exact: true })).toContainText('live');
});
