import { MarketplaceBrowser } from '../server/browser';
const browser = new MarketplaceBrowser();
try {
  const page = await browser.open(false);
  await page.goto('https://mymarket.ge/', { waitUntil: 'domcontentloaded' });
  console.log('Complete MyMarket login in the visible browser, using phone if offered. Do not create a listing. Close the browser when finished. The private session stays on this machine. Stop the app before running this command.');
  await new Promise<void>(resolve => browser.context!.on('close', () => resolve()));
} finally { await browser.close().catch(() => {}); }
