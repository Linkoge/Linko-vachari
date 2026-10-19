import { chromium, BrowserContext, Page } from 'playwright';
import { join } from 'node:path';
import { config, privateDir } from './config';
import { WorkflowError } from './types';
import { PrivateDisplay } from './display';
import { redactSecrets } from './secrets';
export interface ElementInfo { controlId?: string; group?: string; id: string; tag: string; role: string; label: string; type: string; href: string; required: boolean; options: string[]; value: string; hasValue: boolean; checked: boolean; disabled: boolean }
export interface Snapshot { url: string; title: string; text: string; elements: ElementInfo[]; images: { alt: string; src: string }[] }
export function allowedUrl(url: string) {
  try { const u = new URL(url); return u.protocol === 'https:' && (['mymarket.ge', 'www.mymarket.ge', 'my.ge', 'www.my.ge'].includes(u.hostname) || isAuthHost(u.hostname)); } catch { return false; }
}
// MyMarket signs in through the shared Tinet account service (observed live: auth.tnet.ge/ka/user/login).
// After the password step the account service hands the session to each sibling platform's own auth host
// (observed live: auth.myauto.ge/?AccessToken=…) before returning to mymarket.ge, so those hops must be navigable.
const ssoPlatforms = ['myauto.ge', 'myparts.ge', 'myhome.ge', 'mymarket.ge', 'my.ge', 'livo.ge', 'swoop.ge', 'tkt.ge'];
export function isAuthHost(hostname: string) { return hostname === 'tnet.ge' || hostname.endsWith('.tnet.ge') || ssoPlatforms.some(p => hostname === 'auth.' + p || hostname === 'id.' + p); }
export function onAuthPage(url: string) { try { return isAuthHost(new URL(url).hostname); } catch { return false; } }
export function isListingUrl(url: string) {
  if (!allowedUrl(url)) return false;
  const path = new URL(url).pathname;
  // Both public detail URL formats are witnessed in MyMarket pages, not category paths.
  return /\/(?:pr|product)\/\d+(?:\/|$)/i.test(path) || /\/product\/.+-\d+\/?$/i.test(path);
}
export function redact(text: string) {
  text = redactSecrets(text);
  for (const name of ['MYMARKET_PHONE', 'MYMARKET_PASSWORD']) { const value = process.env[name]; if (value && value.length > 3) text = text.split(value).join('[private credential]'); }
  return text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[private email]').replace(/(?:\+?995[\s-]*)?5\d{2}[\s-]*\d{2,3}[\s-]*\d{2}[\s-]*\d{2,3}\b/g, '[private phone]');
}
function safeUrl(value: string) { try { const u = new URL(value); u.hash = ''; for (const key of [...u.searchParams.keys()]) if (/token|auth|code|session|state|password|phone|email/i.test(key)) u.searchParams.set(key, '[private]'); return u.href; } catch { return value; } }
function browserEnvironment(display: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key];
  if (display) env.DISPLAY = display;
  return env;
}
const challengeTitle = /just a moment|attention required|security verification|checking your browser/i;
// Known benign site overlays (cookie consent, promo notice); they intercept clicks on the real MyMarket pages.
const overlayButtons = [/^ვეთანხმები ყველას$/, /^გასაგებია$/, /^accept all$/i, /^got it$/i];
export class MarketplaceBrowser {
  context?: BrowserContext; page?: Page;
  display = new PrivateDisplay();
  accountId = 'legacy';
  profilePath() { return this.accountId === 'legacy' ? join(privateDir, 'browser') : join(privateDir, 'browsers', this.accountId); }
  async useAccount(id: string) {
    if (!/^(legacy|[a-f0-9-]{36})$/.test(id)) throw new WorkflowError('ACCOUNT', 'Invalid account profile.');
    if (id === this.accountId) return;
    await this.close(); this.accountId = id;
  }
  async open(headless = config.headless) {
    if (this.page && !this.page.isClosed()) return this.page;
    const display = headless ? '' : await this.display.open();
    // A persistent real-Chromium profile, headed on the private display, with the automation markers removed.
    // Observed live: Cloudflare rejects the default HeadlessChrome user agent (403) but admits a normal headed profile.
    this.context = await chromium.launchPersistentContext(this.profilePath(), { headless, viewport: { width: 1360, height: 900 }, locale: 'ka-GE', env: browserEnvironment(display), args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
    // Disallow model-directed external navigation; normal asset requests are unaffected.
    await this.context.route('**/*', async route => {
      const r = route.request();
      if (r.isNavigationRequest() && r.frame() === r.frame().page().mainFrame() && !allowedUrl(r.url())) await route.abort(); else await route.continue();
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    if (headless) {
      const agent = await this.page.evaluate(() => navigator.userAgent);
      if (/Headless/.test(agent)) await (await this.context.newCDPSession(this.page)).send('Network.setUserAgentOverride', { userAgent: agent.replace('HeadlessChrome', 'Chrome') });
    }
    this.page.setDefaultTimeout(8_000); return this.page;
  }
  isChallengePage(title: string, text: string) { return challengeTitle.test(title) || /performing security verification|verifies you are not a bot|verify you are human/i.test(text); }
  // Wait for an interstitial security check to resolve by itself; a real profile normally passes within seconds.
  async settle(page: Page, maxMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const challenged = this.isChallengePage(await page.title().catch(() => ''), await page.locator('body').innerText({ timeout: 2000 }).then(t => t.slice(0, 600)).catch(() => ''));
      if (!challenged) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  }
  async dismissOverlays(page: Page) {
    for (const name of overlayButtons) {
      const button = page.getByRole('button', { name }).first(); const text = page.getByText(name).first();
      const target = (await button.count()) ? button : text;
      if ((await target.count()) && await target.isVisible().catch(() => false)) { await target.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400); }
    }
  }
  async go(url: string, page?: Page) {
    page ||= await this.open();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!await this.settle(page)) throw new WorkflowError('CHALLENGE', 'MyMarket is showing a Cloudflare security check that the assistant could not pass on its own. Retry after the security check clears.');
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await this.dismissOverlays(page); return page;
  }
  async home() { return this.go('https://mymarket.ge/'); }
  async snapshot(page = this.page!): Promise<Snapshot> {
    if (!page) throw new WorkflowError('BROWSER', 'Open the local marketplace browser before continuing.');
    // A click that navigates leaves the page mid-load; observe only once the new document is ready, retrying if it swaps under us.
    for (let attempt = 0; ; attempt++) {
      try { await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }); await page.waitForSelector('body', { state: 'attached', timeout: 10_000 }); await this.dismissOverlays(page); return await this.observe(page); }
      catch (e) { if (attempt >= 3 || !/context was destroyed|navigat|detached|Target closed|Cannot read properties of null/i.test(String((e as Error).message))) throw e; await page.waitForTimeout(800); }
    }
  }
  private async observe(page: Page): Promise<Snapshot> {
    // The TypeScript runner wraps named helpers in __name(); the page has no such global.
    await page.evaluate('window.__name = window.__name || (f => f)');
    const snapshot = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="combobox"],[role="option"],[role="tab"],[contenteditable="true"],.fast-option')).filter(e => (!!(e as HTMLElement).getClientRects().length && getComputedStyle(e).visibility !== 'hidden') || (e as HTMLInputElement).type === 'file').slice(0, 350).map((e, index) => {
        const id = 'e' + index; e.setAttribute('data-linko', id);
        const f = e as HTMLInputElement;
        const associated = 'labels' in f ? Array.from(f.labels || []).map(l => { const copy = l.cloneNode(true) as HTMLElement; copy.querySelectorAll('input,textarea,select,button').forEach(e => e.remove()); return copy.textContent || ''; }).join(' ') : '';
        const labelledby = (e.getAttribute('aria-labelledby') || '').split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ');
        // Custom widgets (react-select comboboxes, button-styled radios) put the field title in a nearby element, not a <label>.
        const groupOf = (el: Element) => {
          const own = (n: Element) => !n.querySelector('input,textarea,select,button,[role=option]') && !n.matches('input,textarea,select,button');
          let n: Element | null = el.closest('.sg-selectbox__control') || el; // the placeholder sits inside the control, the title above it
          for (let depth = 0; depth < 6 && n; depth++, n = n.parentElement) {
            let sib = n.previousElementSibling;
            for (let hops = 0; sib && hops < 2; hops++, sib = sib.previousElementSibling) {
              const t = (sib.textContent || '').replace(/\s+/g, ' ').trim();
              if (t && t.length <= 80 && own(sib)) return t;
            }
          }
          return '';
        };
        // MyMarket's button-styled radios track their selection with an `active` class, not the checked property.
        const isOn = !!f.checked || (['radio', 'checkbox'].includes(f.type) && e.classList.contains('active'));
        const control = e.closest('.sg-selectbox__control');
        const chosen = control?.querySelector('.sg-selectbox__single-value')?.textContent?.trim() || '';
        const group = (f.type === 'radio' || f.type === 'checkbox' || e.getAttribute('role') === 'combobox' || f.type === 'file' ? groupOf(e) : '').slice(0, 120);
        const placeholder = control?.querySelector('.sg-selectbox__placeholder')?.textContent?.trim() || '';
        const fieldControl = e.matches('input,textarea,select,[role=combobox]');
        const nearby = fieldControl ? groupOf(e) : '';
        const label = (associated || labelledby || e.getAttribute('aria-label') || group || nearby || e.getAttribute('placeholder') || placeholder || (!fieldControl ? e.textContent : '') || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const controlId = e.getAttribute('name') ? 'name:' + e.getAttribute('name') : e.id ? 'id:' + e.id : undefined;
        return { controlId, id, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || (e.classList.contains('fast-option') ? 'option' : ''), label, type: f.type || '', href: e instanceof HTMLAnchorElement ? e.href : '', group, required: f.required || e.getAttribute('aria-required') === 'true' || /\*/.test(associated) || /\*/.test(label + group + placeholder), options: e instanceof HTMLSelectElement ? Array.from(e.options).filter(o => !o.disabled && o.value).map(o => o.text) : [], value: f.type === 'password' || /phone|mobile|email|მობილურ|ტელეფონ|ელ.?ფოსტ/i.test(label) ? '' : (e instanceof HTMLSelectElement ? (f.value ? e.selectedOptions[0]?.text || '' : '') : f.value || chosen || '').slice(0, 6000), hasValue: ['radio', 'checkbox'].includes(f.type) ? isOn : !!f.value || !!chosen, checked: isOn || e.getAttribute('aria-selected') === 'true', disabled: f.disabled || e.getAttribute('aria-disabled') === 'true' };
      });
      return { url: location.href, title: document.title, text: document.body.innerText.slice(0, 22_000), elements, images: Array.from(document.images).filter(e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').slice(0, 80).map(i => ({ alt: i.alt, src: /^(blob:|data:)/.test(i.src) ? '[local preview]' : i.src.split('?')[0] })) };
    });
    snapshot.text = redact(snapshot.text); snapshot.title = redact(snapshot.title); snapshot.url = safeUrl(snapshot.url);
    snapshot.elements.forEach(e => { e.label = redact(e.label); e.group = redact(e.group || ''); e.value = redact(e.value); e.href = safeUrl(e.href); e.options = e.options.map(redact); });
    snapshot.images.forEach(i => { i.alt = redact(i.alt); i.src = safeUrl(i.src); });
    // Only the interstitial's own title/opening text counts: real pages carry a footer "protected by reCAPTCHA" notice.
    if (this.isChallengePage(snapshot.title, snapshot.text.slice(0, 800))) throw new WorkflowError('CHALLENGE', 'MyMarket is showing a browser security check. The assistant waits for these to clear; if it persists, retry after the check clears.');
    return snapshot;
  }
  async close() { await this.context?.close(); this.context = undefined; this.page = undefined; this.display.close(); }
}
