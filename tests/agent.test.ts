import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, Browser, Page } from 'playwright';
import { mkdtempSync, statSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { MarketplaceBrowser, redact, allowedUrl } from '../server/browser';
import { createApp } from '../server/app';
import { WorkflowError } from '../server/types';
import { installMarketFixture, MarketOptions } from './fixtures/market-fixture';
const IDENTIFIER = 'owner-login-7731', PASSWORD = ['Pw', 'fixture', '9482!'].join('-'), CODE = '482913';
const until = async (check: () => boolean, ms = 30_000) => { const start = Date.now(); while (!check()) { if (Date.now() - start > ms) throw new Error('timed out waiting for condition ' + check.toString()); await new Promise(r => setTimeout(r, 100)); } };
async function setup(options: MarketOptions, saved = true) {
  const browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage();
  const fixture = await installMarketFixture(context, options);
  const dir = mkdtempSync(join(tmpdir(), 'linko-agent-')); const vault = new CredentialVault(join(dir, 'mymarket-account.json'));
  if (saved) vault.save({ identifier: IDENTIFIER, password: PASSWORD });
  const store = new Store(':memory:'); const flow = new Workflow(store, async () => { throw new WorkflowError('CODEX', 'fixture brain stop'); }, vault); flow.browser.page = page;
  const close = async () => { await browser.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { browser, page, fixture, vault, store, flow, agent: flow.auth, dir, close };
}
const everything = (agent: { status(): unknown }) => JSON.stringify(agent.status());

test('agent signs in with saved credentials, asks the owner for the SMS code, and the owner just types it back', { timeout: 90_000 }, async () => {
  const t = await setup({ password: PASSWORD, code: CODE });
  try {
    t.agent.login();
    await until(() => t.agent.state === 'awaiting_code');
    assert.equal(t.agent.status().awaiting, 'code'); assert.equal(t.flow.busy, true, 'browser stays reserved while the code is awaited');
    assert.deepEqual(t.fixture.logins, [{ identifier: IDENTIFIER, password: PASSWORD }]);
    assert.match(t.agent.messages.at(-1)!.text, /verification code/);
    assert.throws(() => t.agent.message('not a code!!!'), /does not look like/);
    assert.equal(t.agent.message(CODE), 'code');
    await until(() => t.agent.state === 'signed_in');
    assert.deepEqual(t.fixture.codes, [CODE]); assert.equal(t.fixture.signedIn, true);
    await until(() => !t.flow.busy);
    // The owner's code is masked in the transcript, and nothing secret appears in what the panel can see.
    const view = everything(t.agent); for (const secret of [PASSWORD, IDENTIFIER, CODE]) assert.ok(!view.includes(secret), 'status leaks a secret');
    assert.ok(t.agent.messages.some(m => m.role === 'owner' && m.text === '••••••'));
    assert.equal(t.agent.message('unrequested'), 'none', 'text is only treated as a code while the agent is waiting for one');
  } finally { await t.close(); }
});

test('a wrong code is re-requested and a rejected password fails with a form prompt, not a retry loop', { timeout: 120_000 }, async () => {
  const t = await setup({ password: PASSWORD, code: CODE });
  try {
    t.agent.login(); await until(() => t.agent.state === 'awaiting_code');
    t.agent.message('000000'); await until(() => t.agent.state === 'awaiting_code' && t.fixture.codes.length === 1);
    assert.match(t.agent.messages.at(-1)!.text, /did not accept that code/);
    t.agent.message(CODE); await until(() => t.agent.state === 'signed_in'); assert.deepEqual(t.fixture.codes, ['000000', CODE]);
    await until(() => !t.flow.busy);
  } finally { await t.close(); }
  const bad = await setup({ password: 'rejected' });
  try {
    bad.agent.login(); await until(() => bad.agent.state === 'failed');
    assert.match(bad.agent.messages.at(-1)!.text, /did not accept that phone\/email and password/);
    assert.equal(bad.fixture.logins.length, 1, 'no automatic retry that could lock the account');
    await until(() => !bad.flow.busy);
    assert.equal(bad.agent.status().state, 'failed');
  } finally { await bad.close(); }
});

test('without saved credentials the agent asks for them once, stores them privately, and continues to sign in', { timeout: 90_000 }, async () => {
  const t = await setup({ password: PASSWORD }, false);
  try {
    t.agent.login(); await until(() => t.agent.state === 'awaiting_credentials');
    assert.equal(t.agent.status().credentials.configured, false);
    t.agent.provideCredentials({ identifier: IDENTIFIER, password: PASSWORD });
    await until(() => t.agent.state === 'signed_in');
    assert.deepEqual(t.fixture.logins, [{ identifier: IDENTIFIER, password: PASSWORD }]);
    assert.equal(t.agent.status().credentials.configured, true); assert.ok(!everything(t.agent).includes(PASSWORD));
    await until(() => !t.flow.busy);
  } finally { await t.close(); }
});

test('a signed-in session is reused: no credentials, form or code are touched on the next run', { timeout: 90_000 }, async () => {
  const t = await setup({ password: PASSWORD });
  try {
    t.agent.login(); await until(() => t.agent.state === 'signed_in'); await until(() => !t.flow.busy);
    assert.equal(t.fixture.logins.length, 1); assert.equal(t.agent.sessionReused, false);
    t.vault.forget(); // even with no credentials configured the saved browser session is enough
    assert.equal(await t.agent.ensureSignedIn(), true);
    assert.equal(t.agent.sessionReused, true); assert.equal(t.fixture.logins.length, 1); assert.equal(t.agent.state, 'signed_in');
    assert.match(t.agent.messages.at(-1)!.text, /reusing the saved session/);
  } finally { await t.close(); }
});

test('a listing run signs in first, pausing for the code in the assistant window, before any Codex decision', { timeout: 90_000 }, async () => {
  const t = await setup({ password: PASSWORD, code: CODE });
  try {
    let brainCalled = false; t.flow.brain = async () => { brainCalled = true; throw new WorkflowError('CODEX', 'fixture brain stop'); };
    const draft = t.store.create(); draft.category = ['Test', 'Category']; draft.price = '10'; draft.description = 'x'; t.store.save(draft);
    const run = t.flow.run(draft.id, 'prepare');
    await until(() => t.agent.state === 'awaiting_code'); assert.equal(brainCalled, false);
    assert.ok(t.store.get(draft.id).events.some(e => /verification code/.test(e.message)), 'the draft activity tells the owner to answer in the assistant window');
    t.agent.message(CODE); await run;
    assert.equal(brainCalled, true); assert.equal(t.fixture.signedIn, true);
    assert.ok(!JSON.stringify(t.store.get(draft.id)).match(new RegExp(`${PASSWORD.replace(/[!]/g, '\\!')}|${CODE}|${IDENTIFIER}`)));
  } finally { await t.close(); }
});

test('Cloudflare interstitials are waited out, overlays dismissed, and a persistent challenge becomes an actionable error', { timeout: 90_000 }, async () => {
  const browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage();
  const adapter = new MarketplaceBrowser(); adapter.page = page;
  try {
    let attempt = 0;
    await context.route('https://mymarket.ge/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: attempt++ === 0 ? '<title>Just a moment...</title><p>Performing security verification</p><script>setTimeout(()=>location.reload(),1200)</script>' : '<title>MyMarket</title><div id="cookiescript_injected_wrapper" style="position:fixed;inset:0"><button onclick="this.parentElement.remove()">ვეთანხმები ყველას</button></div><a href="/">Home</a>' }));
    await adapter.home(); assert.equal(await page.title(), 'MyMarket'); assert.equal(await page.locator('#cookiescript_injected_wrapper').count(), 0);
    await context.unroute('https://mymarket.ge/**');
    await context.route('https://mymarket.ge/**', route => route.fulfill({ status: 403, contentType: 'text/html; charset=utf-8', body: '<title>Just a moment...</title><p>Performing security verification</p>' }));
    await page.goto('https://mymarket.ge/'); assert.equal(await adapter.settle(page, 1500), false);
    await assert.rejects(adapter.go('https://mymarket.ge/', page), (e: WorkflowError) => e.code === 'CHALLENGE' && /security check/.test(e.message));
  } finally { await browser.close(); }
});

test('sign-in hosts are allowlisted and challenge/headless fingerprints are handled by the persistent profile launch', () => {
  assert.equal(allowedUrl('https://auth.tnet.ge/ka/user/login/?Continue=https://mymarket.ge/'), true);
  assert.equal(allowedUrl('https://tnet.ge.evil.example/'), false); assert.equal(allowedUrl('http://auth.tnet.ge/'), false);
  const source = readFileSync('server/browser.ts', 'utf8');
  assert.match(source, /AutomationControlled/); assert.match(source, /enable-automation/); assert.match(source, /launchPersistentContext/);
});

test('credentials vault: private file mode, masked hint, redaction, env fallback, removal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linko-vault-')); const file = join(dir, 'mymarket-account.json');
  const { MYMARKET_PHONE: phone, MYMARKET_PASSWORD: password } = process.env;
  const saved = { phone, password };
  delete process.env.MYMARKET_PHONE; delete process.env.MYMARKET_PASSWORD;
  try {
    const vault = new CredentialVault(file); assert.equal(vault.configured, false); assert.deepEqual(vault.status(), { configured: false, hint: '', source: 'none' });
    vault.save({ identifier: '+995 555 123 456', password: PASSWORD });
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(readdirSync(dir).length, 1, 'no temporary credential file left behind');
    assert.ok(!JSON.stringify(vault.status()).includes(PASSWORD)); assert.equal(vault.status().hint, '•••456');
    assert.equal(redact(`typed ${PASSWORD} and +995 555 123 456 here`).includes(PASSWORD), false);
    assert.equal(new CredentialVault(file).get()?.password, PASSWORD, 'persists across restarts');
    assert.throws(() => vault.save({ identifier: 'x', password: '' }));
    vault.clear(); assert.equal(vault.configured, false); assert.equal(readdirSync(dir).length, 0);
    assert.equal(redact(`typed ${PASSWORD}`).includes('[private credential]'), false, 'removed secrets are no longer tracked');
    process.env.MYMARKET_PHONE = 'env-owner-55'; process.env.MYMARKET_PASSWORD = 'env-pass';
    assert.equal(new CredentialVault(file).status().source, 'environment');
    assert.equal(new CredentialVault(file).status().hint, '•••55');
  } finally {
    for (const [name, value] of [['MYMARKET_PHONE', saved.phone], ['MYMARKET_PASSWORD', saved.password]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credentials are excluded from git, API responses and client bundle sources', async () => {
  // The default vault location and the environment/credential file names are git-ignored.
  for (const path of ['.private/mymarket-account.json', '.private/browser/Default/Cookies', 'mymarket-account.json', '.env']) execFileSync('git', ['check-ignore', '-q', path]);
  const t = await setup({ password: PASSWORD, code: CODE }, false);
  const { app } = createApp(t.store, t.flow); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: unknown) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
  try {
    assert.equal((await call('/api/agent')).status, 200);
    const unknownField = await call('/api/agent/credentials', 'POST', { identifier: IDENTIFIER, password: PASSWORD, extra: 'x' }); assert.equal(unknownField.status, 400); assert.ok(!unknownField.text.includes(PASSWORD));
    const saved = await call('/api/agent/credentials', 'POST', { identifier: IDENTIFIER, password: PASSWORD });
    assert.equal(saved.status, 200); assert.equal(JSON.parse(saved.text).credentials.configured, true);
    // Start sign-in through the API, answer the code through the API.
    assert.equal((await call('/api/agent/login', 'POST', {})).status, 202);
    await until(() => t.agent.state === 'awaiting_code');
    assert.equal((await call('/api/agent/message', 'POST', { text: CODE })).status, 200);
    await until(() => t.agent.state === 'signed_in'); await until(() => !t.flow.busy);
    const responses = [(await call('/api/agent')).text, (await call('/api/config')).text, (await call('/api/health')).text, saved.text];
    for (const body of responses) for (const secret of [PASSWORD, CODE, IDENTIFIER]) assert.ok(!body.includes(secret), 'API response leaked a secret');
    assert.equal((await call('/api/agent/message', 'POST', { text: 'a'.repeat(300) })).status, 400);
    // Nothing the owner typed is retained on disk other than the vault file itself.
    const vaultFile = readFileSync(t.vault.file, 'utf8'); assert.ok(vaultFile.includes(PASSWORD));
    assert.equal(statSync(t.vault.file).mode & 0o777, 0o600);
    assert.equal((await call('/api/agent/credentials', 'DELETE')).status, 200); assert.equal(t.vault.configured, false);
    // No tracked file or client source references stored credentials.
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(f => f && /^(src|public|dist)\//.test(f));
    for (const file of tracked) { try { const text = readFileSync(file, 'utf8'); assert.ok(!text.includes('mymarket-account') && !text.includes('MYMARKET_PASSWORD'), file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ERR_INVALID_ARG_VALUE') { if (!(e instanceof Error) || !/utf8|invalid/i.test(e.message)) throw e; } } }
  } finally { server.close(); await t.close(); }
});

test('the code prompt is only accepted while one is pending and times out cleanly', async () => {
  const t = await setup({ password: PASSWORD });
  try {
    assert.equal(t.agent.message('hello'), 'none'); assert.ok(t.agent.messages.at(-1)!.text.includes('sign in'));
    assert.equal(t.agent.message('please sign in'), 'login');
    const quick = new (t.agent.constructor as typeof import('../server/agent').LoginAgent)(t.flow, t.vault, 150);
    t.vault.forget();
    t.flow.busy = true; const run = quick.ensureSignedIn(); await until(() => quick.state === 'awaiting_credentials');
    await assert.rejects(run, /did not arrive in time/); assert.equal(quick.state, 'failed'); t.flow.busy = false;
    writeFileSync(join(t.dir, 'unused'), '');
  } finally { await t.close(); }
});

test('ordinary pages mentioning reCAPTCHA in the footer are not mistaken for a security challenge', async () => {
  const browser = await chromium.launch(); const page = await browser.newPage(); const adapter = new MarketplaceBrowser(); adapter.page = page;
  try {
    await page.setContent(`<title>MyMarket search</title><main>${'<a href="/product/1">Camera</a> '.repeat(40)}</main><footer>This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply</footer>`);
    assert.equal((await adapter.snapshot()).elements.length > 10, true);
    await page.setContent('<title>Just a moment...</title><p>Performing security verification</p>');
    await assert.rejects(adapter.snapshot(), (e: WorkflowError) => e.code === 'CHALLENGE');
  } finally { await browser.close(); }
});

test('search_enter types the supplied query before submitting and refuses non-input controls', async () => {
  const t = await setup({ password: PASSWORD }, false);
  try {
    await t.page.route('https://mymarket.ge/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Search</title><label>Search<input type="search" onkeydown="if(event.key===\'Enter\')document.title=\'submitted:\'+this.value"></label><button>Search</button>' }));
    await t.page.goto('https://mymarket.ge/');
    const snapshot = await t.flow.browser.snapshot(t.page); const draft = t.store.create();
    const input = snapshot.elements.find(e => e.tag === 'input')!, button = snapshot.elements.find(e => e.tag === 'button')!;
    const decision = (target: string) => ({ action: 'search_enter' as const, target, source: 'query', value: '', questions: [], reason: 'test' });
    await assert.rejects(t.flow.step(t.page, snapshot, decision(button.id), draft, 'search', 'Canon EOS R50'), /uncertain form submission/);
    await t.flow.step(t.page, snapshot, decision(input.id), draft, 'search', 'Canon EOS R50');
    assert.equal(await t.page.title(), 'submitted:Canon EOS R50');
  } finally { await t.close(); }
});

test('sign-in follows the single-sign-on hop through the platform auth host before it reports success', { timeout: 90_000 }, async () => {
  const t = await setup({ password: PASSWORD, sso: true });
  try {
    t.agent.login(); await until(() => t.agent.state === 'signed_in'); await until(() => !t.flow.busy);
    assert.equal(t.fixture.signedIn, true); assert.match(new URL(t.page.url()).hostname, /^mymarket\.ge$/);
    assert.ok(!everything(t.agent).includes(PASSWORD));
  } finally { await t.close(); }
});

test('a login form encountered during search or preparation signs in automatically before the model observes the page', { timeout: 90_000 }, async () => {
  const t = await setup({ password: PASSWORD });
  try {
    let observations = 0;
    t.flow.brain = (async (_schema, _instructions, input) => {
      observations++; const data = JSON.parse(input);
      assert.equal(data.page.elements.some((e: { type: string }) => e.type === 'password'), false);
      return { action: 'done', target: '', source: '', value: '', questions: [], reason: 'signed in' };
    }) as typeof t.flow.brain;
    for (const phase of ['search', 'prepare'] as const) {
      t.fixture.signedIn = false; await t.page.goto('https://auth.tnet.ge/ka/user/login/');
      await t.flow.agent(t.page, t.store.create(), phase, 'lamp', 3);
      assert.equal(t.fixture.signedIn, true);
    }
    assert.equal(observations, 2); assert.equal(t.fixture.logins.length, 2);
    assert.equal('manualActive' in t.flow, false);
  } finally { await t.close(); }
});
