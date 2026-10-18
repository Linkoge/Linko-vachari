import { useEffect, useRef, useState } from 'react';

/** Sign-in runs in the background. Only a requested verification code needs UI. */
export function VerificationPrompt() {
  const [awaiting, setAwaiting] = useState(false), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/agent', { signal: AbortSignal.timeout(10_000) });
        if (r.ok) { const data = await r.json(); if (!stopped) setAwaiting(data.awaiting === 'code'); }
      } catch { /* Reconnect on the next poll. */ }
    };
    void poll(); const timer = setInterval(() => void poll(), 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  useEffect(() => { if (awaiting) dialog.current?.showModal(); else { dialog.current?.close(); setCode(''); setError(''); } }, [awaiting]);
  return <dialog ref={dialog} className="modal verification-prompt" aria-labelledby="verification-title" onCancel={e => e.preventDefault()}>
    <h2 id="verification-title">MyMarket verification</h2>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(''); const text = code; setCode('');
      try {
        const r = await fetch('/api/agent/message', { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: JSON.stringify({ text }) });
        const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Code could not be sent.');
        setAwaiting(data.awaiting === 'code');
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}><label>Verification code<input type="password" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} maxLength={200} required disabled={busy}/></label>
      {error && <p role="alert">{error}</p>}<button className="button primary" disabled={busy || !code.trim()}>Send code</button>
    </form>
  </dialog>;
}
