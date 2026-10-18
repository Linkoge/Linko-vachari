import { MarketplaceBrowser, redact } from '../server/browser';
const browser = new MarketplaceBrowser();
try {
  const page = await browser.home();
  console.log(JSON.stringify({ title: redact(await page.title()), origin: new URL(page.url()).origin, realListingsPublished: 0 }));
} finally { await browser.close(); }
