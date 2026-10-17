import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  const response = await page.goto('https://mymarket.ge/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);
  const data = { checkedAt: new Date().toISOString(), status: response?.status(), url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 2500), links: await page.locator('a').evaluateAll(es => es.slice(0, 80).map(e => ({ text: e.textContent?.trim(), href: (e as HTMLAnchorElement).href }))), images: await page.locator('img').evaluateAll(es => es.slice(0, 10).map(e => ({ src: (e as HTMLImageElement).src, alt: (e as HTMLImageElement).alt }))) };
  await writeFile('docs/evidence/live-inspection.json', JSON.stringify(data, null, 2));
  await page.screenshot({ path: 'docs/evidence/live-home.png' });
  console.log(JSON.stringify(data, null, 2));
} finally { await browser.close(); }
