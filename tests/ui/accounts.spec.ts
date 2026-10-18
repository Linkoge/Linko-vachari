import { test, expect } from '@playwright/test';
import { randomUUID, randomInt } from 'node:crypto';
test('Settings saves several accounts privately and draft account choice persists as the next default', async ({ page }, info) => {
  const marker = randomUUID();
  await page.goto('/');
  await page.screenshot({ path: info.outputPath('accounts-overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const accounts = page.getByLabel('MyMarket accounts');
  for (const label of ['Personal', 'Shop']) {
    await accounts.getByLabel('Account label').fill(label);
    await accounts.getByLabel('Account email').fill('owner@x.io');
    await accounts.getByLabel('Account password').fill(marker);
    await accounts.getByRole('button', { name: 'Add MyMarket account' }).click();
    await expect(accounts.getByRole('button', { name: 'Remove account ' + label })).toBeVisible();
    await expect(accounts.getByLabel('Account password')).toHaveValue('');
  }
  await expect(accounts).toContainText('0 of 5 free listings used');
  const defaults = accounts.getByRole('form', { name: 'Defaults for Personal', exact: true });
  await expect(defaults.getByLabel('Default city')).toHaveValue('თბილისი');
  const phone = '5' + randomInt(10_000_000, 99_999_999);
  await defaults.getByLabel('Default city').fill('ბათუმი');
  await defaults.getByLabel('Listing phone number').fill(phone);
  await defaults.getByRole('button', { name: 'Save account defaults' }).click();
  await expect(defaults.getByRole('button')).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(defaults.getByLabel('Listing phone number')).toHaveValue(phone);
  await accounts.screenshot({ path: info.outputPath('accounts-settings.png') });
  const response = await page.request.get('/api/accounts'); const raw = await response.text(); expect(raw).not.toContain(marker); expect(raw).not.toContain('owner@x.io');
  const list = JSON.parse(raw).accounts;
  await page.getByRole('button', { name: 'New listing', exact: true }).click();
  await page.getByRole('button', { name: 'New draft' }).click();
  await expect(page.getByLabel('Listing account')).toHaveValue(list.find((a: any) => a.label === 'Shop').id);
  await page.getByLabel('Listing account').selectOption(list.find((a: any) => a.label === 'Personal').id);
  await expect(page.getByLabel('City', { exact: true })).toHaveValue('ბათუმი');
  await page.getByLabel('City', { exact: true }).fill('ქუთაისი');
  await expect(page.locator('.lean-publish span')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New draft' }).click();
  await expect(page.getByLabel('Listing account')).toHaveValue(list.find((a: any) => a.label === 'Personal').id);
  await expect(page.getByLabel('City', { exact: true })).toHaveValue('ბათუმი');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  page.once('dialog', d => d.accept());
  await accounts.getByRole('button', { name: 'Remove account Shop' }).click();
  await expect(accounts.getByRole('button', { name: 'Remove account Shop' })).toHaveCount(0);
  expect(await page.evaluate(value => JSON.stringify([localStorage, sessionStorage]).includes(value), marker)).toBe(false);
});

test('uncertain tree results present three paths and preserve the owner choice', async ({ page }) => {
  let draft: any, candidates: any;
  await page.route('**/api/drafts', async r => { const response = await r.fetch(); const json = await response.json(); if (r.request().method() === 'POST') draft = json; await r.fulfill({ response, json }); });
  await page.route('**/api/drafts/*', r => {
    if (r.request().method() === 'GET' && candidates) return r.fulfill({ json: candidates });
    return r.continue();
  });
  await page.route('**/api/drafts/*/analyze', async r => {
    draft = await (await page.request.get('/api/drafts/' + draft.id)).json();
    candidates = { ...draft, state: 'needs_input', categoryMethod: 'tree', categoryCandidates: [['Lighting', 'Studio lamps'], ['Lighting', 'Bulbs'], ['Furniture', 'Tables']], message: 'Choose the best category from the suggested existing paths.' };
    await r.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.goto('/');
  await expect(page.locator('input[type=file]')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles('public/icons/icon-192.png');
  await expect(page.getByAltText('Item photo 1')).toBeVisible();
  await page.getByLabel('Asking price').fill('25'); await page.getByLabel('Description', { exact: false }).fill('Studio lamp with stand');
  await page.getByRole('button', { name: 'Find category' }).click();
  const choices = page.getByRole('group', { name: 'Choose a category' });
  await expect(choices.getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await choices.getByRole('button', { name: 'Lighting › Studio lamps' }).click();
  await expect(page.getByLabel('Category path')).toHaveValue('Lighting > Studio lamps');
  await expect(page.locator('.lean-publish span')).toHaveText('Saved'); candidates = undefined;
  const saved = await (await page.request.get('/api/drafts/' + draft.id)).json(); expect(saved.category).toEqual(['Lighting', 'Studio lamps']);
});
