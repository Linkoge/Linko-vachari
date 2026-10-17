import { useEffect, useState } from 'react';
import { App } from './App';
import { clearCache } from './cache';
export function AuthGate() {
  const [status, setStatus] = useState<{ signedIn: boolean; configured: boolean; tailnet: boolean }>();
  const [password, setPassword] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    const check = async () => {
      if (!navigator.onLine) { setStatus({ signedIn: true, configured: true, tailnet: false }); return; }
      try { const r = await fetch('/api/auth/status', { cache: 'no-store' }); const value = await r.json(); if (!r.ok) throw new Error(value.message); setStatus(value); }
      catch (e) { setMessage((e as Error).message || 'Connect to your private workspace.'); }
    };
    void check();
    const signOut = () => { setPassword(''); void clearCache(); setStatus({ signedIn: false, configured: true, tailnet: true }); };
    window.addEventListener('linko-signed-out', signOut); window.addEventListener('online', check);
    return () => { window.removeEventListener('linko-signed-out', signOut); window.removeEventListener('online', check); };
  }, []);
  if (status?.signedIn) return <App/>;
  return <div className="auth-page"><form className="modal" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setMessage('');
    const submitted = password; setPassword('');
    try { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: JSON.stringify({ password: submitted }), cache: 'no-store' }); const data = await r.json(); if (!r.ok) throw new Error(data.message); setStatus(s => s ? { ...s, signedIn: true } : { signedIn: true, configured: true, tailnet: true }); }
    catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }}><img className="auth-icon" src="/icons/icon-192.png" alt="Linko"/><h2>Sign in to Linko</h2><p>Your private listing workspace. This panel password is separate from your MyMarket account.</p>{!status ? <p>Connecting to your protected workspace…</p> : !status.configured ? <p>The operator needs to complete protected panel setup before you can sign in.</p> : <><label>Panel password<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} maxLength={256} required/></label><button className="button primary" type="submit" disabled={busy || password.length < 12}>{busy ? 'Signing in…' : 'Sign in to panel'}</button></>}{message && <div className="notice error" role="alert">{message}</div>}<small>Access is restricted to authorized Tailscale users. No provider key is needed; the server uses Codex’s normal sign-in.</small></form></div>;
}
