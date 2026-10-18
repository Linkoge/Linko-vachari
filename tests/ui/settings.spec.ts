import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

for (const size of [{ width: 1360, height: 1000 }, { width: 390, height: 844 }]) {
  test(`AI slots and Telegram setup persist at ${size.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    const ai = { everyday: { provider: 'codex', model: 'small-choice', effort: 'low' }, fixit: { provider: 'claude', model: 'opus', effort: 'high' } };
    let saved = { ai, telegram: { configured: false, chatId: '' } }; let sent = 0, detected = 0;
    const marker = randomUUID();
    await page.route('**/api/settings', r => r.fulfill({ json: { ...saved, providers: { codex: { installed: true, signedIn: true, message: 'Signed in with local subscription' }, claude: { installed: false, signedIn: false, message: 'CLI not installed, unsupported, or status check timed out' } } } }));
    await page.route('**/api/settings/ai', r => { saved = { ...saved, ai: r.request().postDataJSON() }; return r.fulfill({ json: saved }); });
    await page.route('**/api/settings/telegram', r => {
      const data = r.request().postDataJSON(); if (data.token) expect(data.token).toBe(marker);
      saved = { ...saved, telegram: { configured: true, chatId: data.chatId } }; return r.fulfill({ json: saved });
    });
    await page.route('**/api/settings/telegram/detect', r => { detected++; return r.fulfill({ json: { chatIds: ['123'] } }); });
    await page.route('**/api/settings/telegram/test', r => { sent++; return r.fulfill({ json: { sent: true } }); });
    await page.goto('/');
    await page.screenshot({path:testInfo.outputPath(`overview-${size.width}.png`),fullPage:true});
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: 'AI', exact: true })).toBeVisible();
    await expect(dialog.locator('fieldset')).toHaveCount(2);
    await expect(dialog.getByLabel('fixit provider')).toHaveValue('claude'); await expect(dialog.getByText(/CLI not installed/)).toBeVisible();
    await dialog.getByLabel('everyday model').fill('saved-choice'); await dialog.getByLabel('everyday effort').selectOption('medium');
    await dialog.getByRole('button', { name: 'Save AI choices' }).click(); await expect(dialog.getByText('AI choices saved.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Close setup' }).click(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('everyday model')).toHaveValue('saved-choice'); await expect(page.getByLabel('everyday effort')).toHaveValue('medium');
    await dialog.screenshot({ path: testInfo.outputPath(`ai-${size.width}.png`) });
    await dialog.getByLabel('Bot token').fill(marker); await dialog.getByRole('button', { name: 'Save Telegram', exact: true }).click();
    await expect(dialog.getByLabel('Bot token')).toHaveValue(''); await expect(dialog.getByText('@BotFather')).toBeAttached();
    await dialog.getByRole('button', { name: 'Detect chat ID', exact: true }).click(); await expect(dialog.getByLabel('Chat ID', { exact: true })).toHaveValue('123');
    await dialog.getByRole('button', { name: 'Save Telegram', exact: true }).click(); await dialog.getByRole('button', { name: 'Send test message', exact: true }).click();
    await expect(dialog.getByText('Test message sent.', { exact: true })).toBeVisible(); expect(sent).toBe(1); expect(detected).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath(`telegram-${size.width}.png`) });
    expect(await page.evaluate(() => Object.values(localStorage).join(' '))).not.toContain(marker);
  });
}
