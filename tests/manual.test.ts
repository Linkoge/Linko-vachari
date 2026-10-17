import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { ManualBrowser } from '../server/manual-browser';
test('owner-controlled browser input/frame uses the automation context, enforces leases and serializes with listing work', async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.route('https://mymarket.ge/**', route => route.fulfill({ contentType: 'text/html', body: '<label>Phone<input type="tel" style="width:200px;height:50px"></label><label>Password<input type="password"></label><p>SMS verification fixture</p>' }));
  const store = new Store(':memory:'); const flow = new Workflow(store); flow.browser.page = page;
  const manual = new ManualBrowser(flow); const draft = store.create();
  try {
    flow.busy = true; await assert.rejects(manual.start('owner-a'), /in use/); flow.busy = false;
    await manual.start('owner-a'); assert.equal(flow.manualActive, true);
    await assert.rejects(flow.run(draft.id, 'analyze'), /manual login/); await assert.rejects(manual.start('owner-b'), /in use/);
    await assert.rejects(manual.frame('owner-b'), /your own/);
    const box = await page.locator('input[type=tel]').boundingBox(); await manual.control('owner-a', { type: 'click', x: box!.x + 20, y: box!.y + 20 });
    await manual.control('owner-a', { type: 'text', text: '000000000' }); assert.equal(await page.locator('input[type=tel]').inputValue(), '000000000');
    await manual.control('owner-a', { type: 'key', key: 'Tab' }); await manual.control('owner-a', { type: 'text', text: 'fixture-only' }); assert.equal(await page.locator('input[type=password]').inputValue(), 'fixture-only');
    const frame = await manual.frame('owner-a'); assert.equal(frame.subarray(0, 2).toString('hex'), 'ffd8');
    await assert.rejects(manual.control('owner-a', { type: 'navigate', url: 'https://evil.example' }));
    const context = page.context(); await manual.stop('owner-a'); assert.equal(flow.manualActive, false); assert.equal(flow.browser.page?.context(), context); await assert.rejects(manual.frame('owner-a'), /Start your own/);
  } finally { await manual.stop('owner-a'); await browser.close(); store.db.close(); }
});
