import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test('protected panel sign-in is distinct from marketplace login; automatic account sign-in and panel sign-out stay separate', async ({ page }) => {
  let signedIn = false; const panelCode = randomUUID();
  await page.route('**/api/auth/status', r => r.fulfill({ json: { signedIn, protected: true, configured: true, tailnet: true } }));
  await page.route('**/api/auth/login', r => { signedIn = r.request().postDataJSON().password === panelCode; return r.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? { signedIn: true } : { message: 'The panel password was not accepted.' } }); });
  await page.route('**/api/config', r => r.fulfill({ json: { codex: { available: true, chatgptSignedIn: true }, publishEnabled: false, mode: 'tailnet', publicOrigin: 'https://owner-node.test-tailnet.ts.net:8443', browser: { active: false, owned: false } } }));
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Sign in to Linko' })).toBeVisible();
  await page.getByLabel('Panel password').fill(panelCode); await page.getByRole('button', { name: 'Sign in to panel' }).click();
  await expect(page.getByRole('heading', { name: 'Sell something good.' })).toBeVisible();
  await page.getByRole('button', { name: 'Connection & setup' }).click();
  await expect(page.getByRole('dialog')).toContainText('MyMarket login is separate');
  await expect(page.getByRole('dialog')).toContainText('No provider key');
  await expect(page.getByRole('dialog')).toContainText('signs in automatically');
  await expect(page.getByRole('button', { name: 'Open private MyMarket browser' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out of Linko panel' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Linko' })).toBeVisible();
  expect(await page.evaluate(value => Object.values(localStorage).join(' ').includes(value), panelCode)).toBe(false);
});
