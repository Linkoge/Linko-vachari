import { writeFile } from 'node:fs/promises';
import { Workflow } from '../server/workflow';
import { Store } from '../server/store';
import { ManualBrowser } from '../server/manual-browser';
import { redact } from '../server/browser';
const store = new Store(':memory:'); const flow = new Workflow(store); const manual = new ManualBrowser(flow);
try {
  await manual.start('local-read-only-probe');
  const page = flow.browser.page!; await page.waitForTimeout(3000); const frame = await manual.frame('local-read-only-probe');
  const challenge = /just a moment|security verification/i.test(await page.title() + await page.locator('body').innerText());
  if (challenge) await writeFile('docs/evidence/private-browser-challenge.jpg', frame);
  const context = flow.browser.context;
  await manual.stop('local-read-only-probe');
  const receipt = { checkedAt: new Date().toISOString(), privateHeadedChromiumOpened: !!context, dedicatedXvfb: !!flow.browser.display.name, frameIsJpeg: frame.subarray(0, 2).toString('hex') === 'ffd8', sameContextRetained: context === flow.browser.context, automationLeaseReleased: !flow.manualActive, landingOrigin: new URL(page.url()).origin, landingTitle: redact(await page.title()), liveMarketplaceChallenge: challenge, authenticatedLoginVerified: false, credentialsEntered: false, realListingsPublished: 0, publicBrowserListenerCreated: false };
  await writeFile('docs/evidence/private-browser-probe.json', JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} finally { await manual.stop('local-read-only-probe'); await flow.browser.close(); store.db.close(); }
