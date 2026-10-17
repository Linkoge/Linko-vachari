import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessBoundary, hashIdentity, passwordHash } from '../server/access';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import { request as httpRequest } from 'node:http';
// Model a real reverse-proxy HTTP request. Node fetch does not reliably preserve an overridden Host.
async function fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<Response>((resolve, reject) => { const req = httpRequest(url, init, res => { const chunks: Buffer[] = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve(new Response(Buffer.concat(chunks).toString(), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v || ''])) }))); }); req.on('error', reject); req.end(init.body); });
}
const origin = 'https://owner-node.test-tailnet.ts.net:8443';
const login = 'owner@example.invalid';
const password = ['test', 'panel', 'passphrase'].join('-');
const salt = '0'.repeat(48);
test('tailnet host/identity boundary, protected panel login, CSRF, cookies, identity binding, expiry, logout and fail-closed setup', async () => {
  const access = new AccessBoundary(origin, { salt, passwordHash: passwordHash(password, salt), allowedLoginHashes: [hashIdentity(login)] });
  const store = new Store(':memory:'); const { app } = createApp(store, undefined, access);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.on('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Host: new URL(origin).host, 'Tailscale-User-Login': login, 'X-Forwarded-Proto': 'https', 'X-Linko-Request': '1', 'Content-Type': 'application/json', Origin: origin };
  try {
    assert.equal((await fetch(base + '/api/auth/status')).status, 403);
    assert.equal((await fetch(base + '/api/auth/status', { headers: { ...headers, 'Tailscale-User-Login': 'outsider@example.invalid' } })).status, 403);
    assert.equal((await fetch(base + '/api/auth/status', { headers: { ...headers, 'X-Forwarded-Proto': 'http' } })).status, 403);
    assert.equal((await fetch(base + '/api/auth/status', { headers: { ...headers, 'Tailscale-Funnel-Request': '?1' } })).status, 403);
    assert.equal((await fetch(base + '/api/auth/status', { headers: { ...headers, Host: 'evil.example' } })).status, 403);
    const denied = await fetch(base + '/api/drafts/missing', { headers }); assert.equal(denied.status, 401, await denied.text());
    assert.equal((await fetch(base + '/api/auth/status', { headers })).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ password }) })).status, 403);
    assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { ...headers, Origin: '' }, body: JSON.stringify({ password }) })).status, 403);
    assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password: ['wrong', 'panel', 'value'].join('-') }) })).status, 401);
    const signedIn = await fetch(base + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password }) }); assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /^__Host-/); assert.equal((await signedIn.text()).includes(password), false);
    const auth = { ...headers, Cookie: cookie.split(';')[0] };
    const created = await fetch(base + '/api/drafts', { method: 'POST', headers: auth, body: '{}' }); assert.equal(created.status, 201);
    assert.match(created.headers.get('strict-transport-security')!, /max-age=/);
    assert.equal((await fetch(base + '/api/auth/status', { headers: { ...auth, 'Tailscale-User-Login': 'outsider@example.invalid' } })).status, 403);
    assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: auth, body: '{}' })).status, 200);
    assert.equal((await fetch(base + '/api/drafts', { method: 'POST', headers: auth, body: '{}' })).status, 401);
    const again = await fetch(base + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password }) });
    const secondCookie = again.headers.get('set-cookie')!.split(';')[0];
    for (const s of access.sessions.values()) s.expires = 0;
    assert.equal((await fetch(base + '/api/drafts', { method: 'POST', headers: { ...headers, Cookie: secondCookie }, body: '{}' })).status, 401);
    assert.equal(access.identity({ headers, socket: { remoteAddress: '100.64.0.20' } } as any), '');
    const closed = new AccessBoundary(origin); closed.settings = undefined; assert.equal(closed.identity({ headers, socket: { remoteAddress: '127.0.0.1' } } as any), '');
  } finally { server.close(); store.db.close(); }
});
test('panel password guessing is bounded and identity/session information never enters responses', async () => {
  const access = new AccessBoundary('', { salt, passwordHash: passwordHash(password, salt), allowedLoginHashes: [hashIdentity(login)] }, true);
  const store = new Store(':memory:'); const { app } = createApp(store, undefined, access); const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.on('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { for (let i = 0; i < 6; i++) assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: JSON.stringify({ password: ['wrong', 'panel', 'value'].join('-') }) })).status, 401); assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: JSON.stringify({ password }) })).status, 429); const status = await (await fetch(base + '/api/auth/status')).text(); assert.equal(status.includes(login), false); assert.equal(status.includes(passwordHash(password, salt)), false); } finally { server.close(); store.db.close(); }
});
