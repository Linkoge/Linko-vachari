import { test, expect } from '@playwright/test';

test('background sign-in has no assistant panel and opens only the required verification prompt', async ({ page }) => {
  let awaiting: string | null = null, received = '';
  await page.route('**/api/agent', r => r.fulfill({ json: { awaiting } }));
  await page.route('**/api/agent/message', r => {
    expect(r.request().headers()['x-linko-request']).toBe('1');
    received = r.request().postDataJSON().text; awaiting = null;
    return r.fulfill({ json: { awaiting } });
  });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'New listing', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('button', { name: /Assistant/ })).toHaveCount(0);
  awaiting = 'code';
  const dialog = page.getByRole('dialog', { name: 'MyMarket verification' }); await expect(dialog).toBeVisible();
  const code = dialog.getByLabel('Verification code'); await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code'); await expect(code).toHaveAttribute('type', 'password');
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  await code.fill('482913'); await dialog.getByRole('button', { name: 'Send code' }).click();
  await expect(dialog).toHaveCount(0); expect(received).toBe('482913');
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('482913'))).toBe(false);
});
