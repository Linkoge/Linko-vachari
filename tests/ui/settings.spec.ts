import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const providers = {
  codex: { installed: true, signedIn: true, message: 'Signed in with local subscription' },
  claude: { installed: false, signedIn: false, message: 'CLI not installed, unsupported, or status check timed out' },
};
const models = {
  codex: [{ name: 'Luna', model: 'gpt-6-luna' }, { name: 'Sol', model: 'gpt-6.1-sol' }, { name: 'Astra', model: 'gpt-6-astra' }].map(m => ({ ...m, efforts: ['low', 'medium', 'high'] })),
  claude: ['haiku', 'sonnet', 'opus'].map(model => ({ name: model[0].toUpperCase() + model.slice(1), model, efforts: ['low', 'medium', 'high'] })),
};
const initialAI = () => ({ everyday: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, fixit: { provider: 'claude', model: 'opus', effort: 'high' } });

for (const size of [{ width: 1360, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`AI picker and Telegram persist at ${size.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    let saved = { ai: initialAI(), telegram: { configured: false, chatId: '' }, automation: { publish: false, autoRelist: false } }; let sent = 0, detected = 0;
    const writes: unknown[] = [], marker = randomUUID();
    await page.route('**/api/settings', r => r.fulfill({ json: { ...saved, providers, models } }));
    await page.route('**/api/settings/ai', r => { writes.push(r.request().postDataJSON()); saved = { ...saved, ai: r.request().postDataJSON() }; return r.fulfill({ json: saved }); });
    await page.route('**/api/settings/telegram', r => {
      const data = r.request().postDataJSON(); if (data.token) expect(data.token).toBe(marker);
      saved = { ...saved, telegram: { configured: true, chatId: data.chatId } }; return r.fulfill({ json: saved });
    });
    await page.route('**/api/settings/telegram/detect', r => { detected++; return r.fulfill({ json: { chatIds: ['123'] } }); });
    await page.route('**/api/settings/telegram/test', r => { sent++; return r.fulfill({ json: { sent: true } }); });
    await page.goto('/');
    await page.screenshot({ path: testInfo.outputPath(`overview-${size.width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('main'), picker = dialog.locator('.ai-picker');
    await expect(dialog.getByRole('heading', { name: 'AI', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button')).toHaveText(['New listing', 'Drafts', 'My listings', 'Settings']);
    await expect(page.getByText(/CLI not installed|@BotFather|Refresh category tree|stored only|Notification failures/)).toHaveCount(0);
    await expect(page.locator('.agent-dock,.setup-status,.ai-provider-status,.ai-help,.ai-slot-description')).toHaveCount(0);
    await expect(dialog.getByRole('heading')).toHaveText(['Settings', 'MyMarket accounts', 'AI', 'Telegram']);
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await expect(picker.locator('fieldset')).toHaveCount(2);
    await expect(picker.locator('.model-choice-row[role=group]')).toHaveCount(8);
    await expect(picker.getByRole('button', { name: 'Everyday Codex Luna', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.getByRole('button', { name: 'Fix-it Claude Opus', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.getByRole('button', { name: 'Everyday Claude Low', exact: true })).toBeDisabled();
    await expect(picker.getByRole('button', { name: 'Fix-it Codex High', exact: true })).toBeDisabled();
    for (const row of await picker.locator('.model-choice-row[role=group]').all()) {
      expect(await row.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(3);
      for (const button of await row.getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(38);
    }
    await picker.getByRole('button', { name: 'Everyday Codex Sol', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Everyday Codex Sol', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: 'Everyday Codex Medium', exact: true }).click();
    await expect(picker.getByRole('button', { name: 'Everyday Codex Medium', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(saved.ai).toEqual({ everyday: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, fixit: initialAI().fixit });
    await dialog.evaluate(el => { el.scrollTop = 0; });
    await dialog.screenshot({ path: testInfo.outputPath(`ai-dialog-${size.width}.png`) });
    await picker.getByRole('button', { name: 'Everyday Claude Sonnet', exact: true }).click();
    await expect(picker.getByRole('button', { name: 'Everyday Claude Medium', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(saved.ai.everyday).toEqual({ provider: 'claude', model: 'sonnet', effort: 'medium' });
    expect(writes).toHaveLength(3);
    for (const slot of await picker.locator('fieldset').all()) await expect(slot.locator('.model-family[aria-pressed=true]')).toHaveCount(1);
    // Focus navigation stays within a row and does not silently save a new choice.
    const first = picker.getByRole('button', { name: 'Everyday Codex Luna', exact: true });
    await first.focus(); await first.press('ArrowLeft');
    await expect(picker.getByRole('button', { name: 'Everyday Codex Astra', exact: true })).toBeFocused();
    await page.keyboard.press('Home'); await expect(first).toBeFocused();
    await page.keyboard.press('End'); await expect(picker.getByRole('button', { name: 'Everyday Codex Astra', exact: true })).toBeFocused();
    expect(writes).toHaveLength(3);
    await picker.screenshot({ path: testInfo.outputPath(`ai-${size.width}.png`) });
    await page.getByRole('button', { name: 'New listing', exact: true }).click();
    await expect(page.locator('.ai-picker')).toHaveCount(0);
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(picker.getByRole('button', { name: 'Everyday Claude Sonnet', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.getByRole('button', { name: 'Everyday Claude Medium', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.getByRole('button', { name: 'Fix-it Claude Opus', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByLabel('Bot token').fill(marker); await dialog.getByRole('button', { name: 'Save Telegram', exact: true }).click();
    await expect(dialog.getByLabel('Bot token')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Detect chat ID', exact: true }).click(); await expect(dialog.getByLabel('Chat ID', { exact: true })).toHaveValue('123');
    await dialog.getByRole('button', { name: 'Save Telegram', exact: true }).click(); await dialog.getByRole('button', { name: 'Send test message', exact: true }).click();
    await expect(dialog.getByText('Test message sent.', { exact: true })).toBeVisible(); expect(sent).toBe(1); expect(detected).toBe(1);
    const layout = await page.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > window.innerWidth).map(el => ({ tag: el.tagName, class: el.className })).slice(0, 10) }));
    expect(layout.content, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath(`telegram-${size.width}.png`) });
    expect(await page.evaluate(() => Object.values(localStorage).join(' '))).not.toContain(marker);
  });
}

test('pending, rejected and lost saves never show an unconfirmed selection or switch provider', async ({ page, context }) => {
  let ai = initialAI(), available = true;
  await page.route('**/api/settings', r => available ? r.fulfill({ json: { ai, telegram: { configured: false, chatId: '' }, automation: { publish: false, autoRelist: false }, providers, models } }) : r.abort());
  let finish: () => void = () => {};
  await page.route('**/api/settings/ai', async r => {
    await new Promise<void>(resolve => { finish = resolve; });
    await r.fulfill({ status: 409, json: { message: 'Wait for the current job before changing AI settings.' } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const picker = page.locator('.ai-picker'), sol = picker.getByRole('button', { name: 'Everyday Codex Sol', exact: true });
  await sol.click();
  await expect(page.getByText('Saving settings', { exact: true })).toBeVisible();
  await expect(sol).toHaveAttribute('aria-pressed', 'false');
  await expect(picker.getByRole('button', { name: 'Fix-it Claude Sonnet', exact: true })).toBeDisabled();
  finish();
  await expect(page.getByRole('alert')).toContainText('Wait for the current job');
  await expect(sol).toHaveAttribute('aria-pressed', 'false');
  await expect(picker.getByRole('button', { name: 'Everyday Codex Luna', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sol).toBeFocused();
  // The write commits but its response is lost: GET is authoritative.
  await page.route('**/api/settings/ai', r => { ai = r.request().postDataJSON(); return r.abort(); });
  await sol.click();
  await expect(sol).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Saved choices restored', { exact: true })).toBeVisible();
  expect(ai.fixit).toEqual(initialAI().fixit);
  // Neither response nor refresh can be confirmed. Clear cached controls and retry.
  available = false;
  await picker.getByRole('button', { name: 'Everyday Codex High', exact: true }).click();
  await expect(picker.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry settings', exact: true })).toBeVisible();
  available = true; await page.getByRole('button', { name: 'Retry settings', exact: true }).click();
  await expect(picker.getByRole('button', { name: 'Everyday Codex High', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await context.setOffline(true);
  await expect(sol).toBeDisabled();
  await expect(page.getByText('Offline · saved choices cannot be changed', { exact: true })).toBeVisible();
});

test('only installed catalog models are offered and unavailable API choices cannot replace saved slots', async ({ page, request }) => {
  const initial = await (await request.get('/api/settings')).json();
  await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const slot = page.locator('.ai-slot').filter({ has: page.locator('legend', { hasText: 'Fix-it' }) });
  await expect(slot.getByText('Use another model', { exact: true })).toHaveCount(0);
  await slot.getByRole('button', { name: 'Fix-it Claude Sonnet', exact: true }).click();
  await slot.getByRole('button', { name: 'Fix-it Claude Medium', exact: true }).click();
  const saved = await (await request.get('/api/settings')).json();
  expect(saved.ai).toEqual({ everyday: initial.ai.everyday, fixit: { provider: 'claude', model: 'sonnet', effort: 'medium' } });
  const rejected = await request.put('/api/settings/ai', { headers: { 'X-Linko-Request': '1' }, data: { ...saved.ai, everyday: { provider: 'codex', model: 'unknown-model', effort: 'low' } } });
  expect(rejected.status()).toBe(409); expect((await rejected.json()).message).toContain('unavailable');
  expect((await (await request.get('/api/settings')).json()).ai).toEqual(saved.ai);
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(slot.getByRole('button', { name: 'Fix-it Claude Sonnet', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(slot.getByRole('button', { name: 'Fix-it Claude Medium', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a saved unavailable model is explained without offering it as a selectable button', async ({ page }) => {
  const ai = initialAI(); ai.everyday.model = 'obsolete-model';
  await page.route('**/api/settings', r => r.fulfill({ json: { ai, models, telegram: { configured: false, chatId: '' }, automation: { publish: false, autoRelist: false } } }));
  await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('obsolete-model · unavailable in the installed CLI catalog. Choose a listed model.')).toBeVisible();
  await expect(page.getByRole('button', { name: /obsolete-model/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Everyday Codex Low', exact: true })).toBeDisabled();
});

test('publish and auto-relist toggles save through the real API and survive navigation and reload', async ({ page, request }) => {
  const initial = await (await request.get('/api/settings')).json();
  try {
    await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const publish = page.getByRole('checkbox', { name: 'Publish', exact: true });
    const relist = page.getByRole('checkbox', { name: 'Auto-relist', exact: true });
    await expect(publish).toBeEnabled();
    await publish.click(); await expect(publish).toBeChecked({ checked: !initial.automation.publish });
    await relist.click(); await expect(relist).toBeChecked({ checked: !initial.automation.autoRelist });
    await expect(relist).toBeEnabled();
    const saved = await (await request.get('/api/settings')).json();
    expect(saved.automation).toEqual({ publish: !initial.automation.publish, autoRelist: !initial.automation.autoRelist });
    expect(saved.ai).toEqual(initial.ai); expect(saved.telegram).toEqual(initial.telegram);
    await page.getByRole('button', { name: 'Drafts', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(publish).toBeChecked({ checked: !initial.automation.publish });
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(relist).toBeChecked({ checked: !initial.automation.autoRelist });
    await expect(publish).toBeChecked({ checked: !initial.automation.publish });
  } finally {
    const reset = await request.put('/api/settings/automation', { headers: { 'X-Linko-Request': '1' }, data: initial.automation });
    expect(reset.status()).toBe(200);
  }
});

test('a rejected automation save restores server state and offline toggles stay disabled', async ({ page, context }) => {
  const automation = { publish: false, autoRelist: true };
  await page.route('**/api/settings', r => r.fulfill({ json: { ai: initialAI(), telegram: { configured: false, chatId: '' }, automation, models } }));
  await page.route('**/api/settings/automation', r => r.fulfill({ status: 500, json: { message: 'Settings could not be saved.' } }));
  await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const publish = page.getByRole('checkbox', { name: 'Publish', exact: true });
  await publish.click(); await expect(page.getByRole('alert')).toContainText('Settings could not be saved.');
  await expect(publish).not.toBeChecked(); await expect(page.getByRole('checkbox', { name: 'Auto-relist', exact: true })).toBeChecked();
  await context.setOffline(true); await expect(publish).toBeDisabled();
});
