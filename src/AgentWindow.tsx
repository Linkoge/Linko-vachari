import { useEffect, useRef, useState } from 'react';
interface AgentStatus {
  state: 'idle' | 'working' | 'awaiting_credentials' | 'awaiting_code' | 'signed_in' | 'failed';
  messages: { id: number; role: 'agent' | 'owner'; text: string; at: string }[];
  awaiting: 'code' | 'credentials' | null; credentials: { configured: boolean; hint: string; source: string };
  signedInAt: string | null; sessionReused: boolean; working: boolean;
}
const labels: Record<AgentStatus['state'], string> = { idle: 'Not signed in yet', working: 'Working in the browser…', awaiting_credentials: 'Needs your MyMarket details', awaiting_code: 'Waiting for your code', signed_in: 'Signed in to MyMarket', failed: 'Needs attention' };
async function call(path: string, method = 'GET', body?: unknown): Promise<AgentStatus> {
  const r = await fetch('/api/agent' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  if (r.status === 401) window.dispatchEvent(new Event('linko-signed-out'));
  const data = await r.json(); if (!r.ok) throw new Error(data.message || 'The assistant could not do that.'); return data;
}
export function AgentWindow({ disabled }: { disabled: boolean }) {
  const [status, setStatus] = useState<AgentStatus>(); const [open, setOpen] = useState(false); const [error, setError] = useState('');
  const [text, setText] = useState(''); const [identifier, setIdentifier] = useState(''); const [password, setPassword] = useState(''); const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = await call(''); if (!stopped) setStatus(next); } catch { /* offline or signed out; the panel handles it */ } if (!stopped) timer = setTimeout(poll, 1500); };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
  // The agent needs the owner: open the window so a code prompt is never missed.
  useEffect(() => { if (status?.awaiting) setOpen(true); }, [status?.awaiting]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [status?.messages.length, open]);
  async function act(path: string, method = 'GET', body?: unknown) { setBusy(true); setError(''); try { setStatus(await call(path, method, body)); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); } }
  const needsForm = !!status && (!status.credentials.configured || status.awaiting === 'credentials' || editing);
  const awaitingCode = status?.awaiting === 'code';
  return <aside className={'agent-dock ' + (open ? 'open' : '')} aria-label="Linko assistant">
    <button className="agent-toggle" onClick={() => setOpen(!open)} aria-expanded={open}><span className={'agent-dot ' + (status?.awaiting ? 'attention' : status?.state === 'signed_in' ? 'ok' : '')}/>{open ? 'Hide assistant' : 'Assistant'}<small>{status ? labels[status.state] : 'Connecting…'}</small></button>
    {open && <div className="agent-window">
      <div className="agent-log" ref={log} role="log" aria-live="polite">
        {!status?.messages.length && <p className="agent-empty">Hi! I sign in to MyMarket for you. Save accounts in Settings; listing runs sign in automatically. If MyMarket texts you a code, type it here.</p>}
        {status?.messages.map(m => <div key={m.id} className={'agent-message ' + m.role}>{m.text}</div>)}
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {needsForm && <form className="agent-credentials" autoComplete="off" onSubmit={async e => { e.preventDefault(); const sent = { identifier, password }; setIdentifier(''); setPassword(''); if (await act('/credentials', 'POST', sent)) setEditing(false); }}>
        <label>MyMarket phone or email<input value={identifier} onChange={e => setIdentifier(e.target.value)} autoComplete="off" maxLength={120} required/></label>
        <label>MyMarket password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" maxLength={256} required/></label>
        <button className="button primary small" disabled={busy || identifier.trim().length < 3 || !password}>Save privately</button>
        <small>Stored only on this server, never shown again or sent to the AI.</small>
      </form>}
      <form className="agent-input" onSubmit={async e => { e.preventDefault(); const value = text; setText(''); if (value.trim()) await act('/message', 'POST', { text: value }); }}>
        <input value={text} onChange={e => setText(e.target.value)} maxLength={200} aria-label={awaitingCode ? 'Verification code' : 'Message to the assistant'} placeholder={awaitingCode ? 'Type the code from SMS or email' : 'Say “sign in”…'} inputMode={awaitingCode ? 'numeric' : 'text'} autoComplete={awaitingCode ? 'one-time-code' : 'off'} disabled={disabled && !awaitingCode}/>
        <button className="button primary small" disabled={busy || !text.trim()}>{awaitingCode ? 'Send code' : 'Send'}</button>
      </form>
      <div className="agent-actions">
        <button className="button ghost small" disabled={busy || disabled || !status || status.working || !status.credentials.configured} onClick={() => void act('/login', 'POST', {})}>{status?.state === 'signed_in' ? 'Check session' : 'Sign in to MyMarket'}</button>
        {status?.credentials.configured && !needsForm && <button className="text-button" onClick={() => setEditing(true)}>Change details ({status.credentials.hint})</button>}
        {status?.credentials.configured && status.credentials.source === 'file' && <button className="text-button" disabled={busy || status.working} onClick={() => { if (confirm('Remove your saved MyMarket details from this server?')) void act('/credentials', 'DELETE'); }}>Remove saved details</button>}
      </div>
    </div>}
  </aside>;
}
