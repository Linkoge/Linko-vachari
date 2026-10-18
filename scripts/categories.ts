import { MarketplaceBrowser } from '../server/browser';
import { CategoryTree } from '../server/categories';
// Run with the service stopped, under `timeout 600s pnpm market:categories`.
const browser = new MarketplaceBrowser();
try {
  const tree = await new CategoryTree().refresh(browser);
  console.log(JSON.stringify({ categories: tree.categories.length, fetchedAt: tree.fetchedAt }));
} finally { await browser.close(); }
