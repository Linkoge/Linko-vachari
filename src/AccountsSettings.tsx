import { useEffect, useState } from 'react';
type Account = { id: string; label: string; hint: string; configured: boolean; activeListings: number };
export function AccountsSettings({ online, onSaved }: { online: boolean; onSaved: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]), [label, setLabel] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function request(path: string, method = 'GET', body?: unknown) {
    const r = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Account settings unavailable.'); return data;
  }
  useEffect(() => { if (online) void request('accounts').then(d => setAccounts(d.accounts)).catch(() => {}); }, [online]);
  async function change(path: string, method: string, body?: unknown) {
    setBusy(true); setMessage('');
    try { const data = await request('settings/' + path, method, body); setAccounts(data.accounts); onSaved(); }
    catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  return <section aria-label="MyMarket accounts"><h3>MyMarket accounts</h3>
    <p>Each account has its own saved browser session. Email and password stay privately on this server.</p>
    {accounts.map(a => <div key={a.id}><strong>{a.label}</strong> <span>{a.hint} · {a.activeListings} of 5 free listings used</span>
      <button type="button" className="text-button" disabled={busy || !online} onClick={() => { if (confirm(`Remove ${a.label}? Its listing history will remain and automation for it will stop.`)) void change('accounts/' + a.id, 'DELETE'); }}>Remove account {a.label}</button></div>)}
    <form autoComplete="off" onSubmit={e => { e.preventDefault(); const input = { label, identifier: email, password }; setPassword(''); setEmail(''); setLabel(''); void change('accounts', 'POST', input); }}>
      <label>Account label<input required maxLength={80} value={label} onChange={e => setLabel(e.target.value)} disabled={busy || !online}/></label>
      <label>Account email<input type="email" required autoComplete="off" maxLength={120} value={email} onChange={e => setEmail(e.target.value)} disabled={busy || !online}/></label>
      <label>Account password<input type="password" required autoComplete="new-password" maxLength={256} value={password} onChange={e => setPassword(e.target.value)} disabled={busy || !online}/></label>
      <button className="button primary" disabled={busy || !online}>Add MyMarket account</button>
    </form>
    <button type="button" className="button ghost" disabled={busy || !online} onClick={async () => { setBusy(true); setMessage('Refreshing category tree…'); try { const t = await request('settings/categories/refresh', 'POST', {}); setMessage(`Saved ${t.count} categories.`); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } }}>Refresh category tree</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
