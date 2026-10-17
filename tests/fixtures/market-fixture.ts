import { BrowserContext } from 'playwright';
// Local stand-in for MyMarket's home page and the shared auth.tnet.ge sign-in service (shapes observed live:
// a cookie banner, a data-testid="signin-button" control, an Email/Password form, optional one-time code step).
export interface MarketFixture { signedIn: boolean; logins: { identifier: string; password: string }[]; codes: string[]; homeVisits: number }
export interface MarketOptions { password: string; code?: string; identifier?: string; captcha?: boolean; sso?: boolean }
const login = (error = '') => `<html><title>Sign in</title><body><form method="post" action="/ka/user/login/"><label>ელფოსტა / მობილურის ნომერი<input type="text" name="Email" autocomplete="off"></label><label>პაროლი<input type="password" name="Password" autocomplete="off"></label><button type="submit">შესვლა</button><button type="submit"></button><button type="submit"></button></form>${error ? `<p role="alert">${error}</p>` : ''}<a href="/ka/user/register/">შექმენი</a></body></html>`;
const verify = (error = '') => `<html><title>Verify</title><body><p>შეიყვანე ერთჯერადი კოდი, რომელიც გამოგიგზავნეთ SMS-ით</p><form method="post" action="/ka/user/verify/"><input type="text" name="otp" autocomplete="one-time-code" maxlength="6" inputmode="numeric"><button type="submit">დადასტურება</button></form>${error ? `<p role="alert">${error}</p>` : ''}</body></html>`;
export async function installMarketFixture(context: BrowserContext, options: MarketOptions): Promise<MarketFixture> {
  const state: MarketFixture = { signedIn: false, logins: [], codes: [], homeVisits: 0 };
  const html = (body: string, status = 200) => ({ status, contentType: 'text/html; charset=utf-8', body });
  await context.route('https://mymarket.ge/**', route => {
    state.homeVisits++;
    const banner = '<div id="cookiescript_injected_wrapper" style="position:fixed;inset:0;background:#0006;z-index:9"><button onclick="this.parentElement.remove()">ვეთანხმები ყველას</button></div>';
    const header = state.signedIn ? '<span>My account</span>' : '<a href="https://auth.tnet.ge/ka/user/login/?Continue=https://mymarket.ge/"><span data-testid="signin-button">შესვლა</span></a>';
    return route.fulfill(html(`<html><title>MyMarket</title><body>${banner}<header>${header}<a href="/create">განცხადების დამატება</a></header><p>${'Welcome to the marketplace. '.repeat(10)}</p></body></html>`));
  });
  await context.route('https://auth.tnet.ge/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const form = new URLSearchParams(request.postData() || '');
    if (request.method() === 'GET') return route.fulfill(html(path.includes('verify') ? verify() : login()));
    if (path.includes('/verify')) {
      const code = form.get('otp') || ''; state.codes.push(code);
      if (code !== options.code) return route.fulfill(html(verify('არასწორი კოდი')));
    } else {
      const identifier = form.get('Email') || '', password = form.get('Password') || '';
      state.logins.push({ identifier, password });
      if (password !== options.password || (options.identifier && identifier !== options.identifier)) return route.fulfill(html(login('არასწორი პაროლი ან ელფოსტა')));
      if (options.code) return route.fulfill(html(verify()));
    }
    // Observed live: the account service hands the session to the platform's own auth host before returning to mymarket.ge.
    if (options.sso) return route.fulfill(html('<html><title>Signing in</title><script>location.replace("https://auth.myauto.ge/?AccessToken=fixture")</script>'));
    state.signedIn = true;
    // A scripted redirect: Playwright does not route the targets of fulfilled 3xx responses.
    return route.fulfill(html('<html><title>Signing in</title><script>location.replace("https://mymarket.ge/")</script>'));
  });
  await context.route('https://auth.myauto.ge/**', route => {
    // The hop completes the session only after a moment; reporting success before it finishes would verify too early.
    setTimeout(() => { state.signedIn = true; }, 2500);
    return route.fulfill(html('<html><title>Signing in</title><script>setTimeout(()=>location.replace("https://mymarket.ge/"),3000)</script>'));
  });
  return state;
}
