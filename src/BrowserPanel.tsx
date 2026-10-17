import { useEffect, useRef, useState } from 'react';
export function BrowserPanel({ onClose }: { onClose: () => void }) {
  const [image, setImage] = useState(''); const [error, setError] = useState(''); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const frameUrl = useRef('');
  async function request(path: string, body?: unknown) {
    const r = await fetch('/api/browser/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    if (r.status === 401) window.dispatchEvent(new Event('linko-signed-out'));
    if (!r.ok) throw new Error((await r.json()).message);
    return r;
  }
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await request('frame'); const blob = await response.blob(); if (stopped) return;
        const next = URL.createObjectURL(blob); URL.revokeObjectURL(frameUrl.current); frameUrl.current = next; setImage(next);
      } catch (e) { if (!stopped) setError((e as Error).message); }
      if (!stopped) timer = setTimeout(refresh, 900);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); URL.revokeObjectURL(frameUrl.current); };
  }, []);
  async function control(body: unknown) { setBusy(true); setError(''); try { await request('control', body); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function finish() { setBusy(true); try { await request('finish', {}); setText(''); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className="modal-backdrop browser-backdrop"><section className="browser-panel" role="dialog" aria-modal="true" aria-labelledby="browser-title"><div className="browser-toolbar"><div><h2 id="browser-title">Private MyMarket browser</h2><p>Sign in directly. Complete any security check or SMS code here. Automation is paused while you control this browser.</p></div><button className="button primary" onClick={() => void finish()} disabled={busy}>Finish login & return</button></div>{error && <div className="notice error" role="alert">{error}</div>}<div className="remote-frame">{image ? <img src={image} alt="Live private MyMarket browser" draggable={false} onClick={e => { if (busy) return; const r = e.currentTarget.getBoundingClientRect(); void control({ type: 'click', x: (e.clientX - r.left) * 1360 / r.width, y: (e.clientY - r.top) * 900 / r.height }); }}/> : <p>Opening your browser…</p>}</div><div className="browser-controls"><form onSubmit={e => { e.preventDefault(); const value = text; setText(''); if (value) void control({ type: 'text', text: value }); }}><label>Type into the selected marketplace field<input type="password" autoComplete="off" aria-label="Text for selected marketplace field" placeholder="Click a field above, type here, then send" value={text} onChange={e => setText(e.target.value)} maxLength={2000}/></label><button className="button ghost" disabled={busy || !text}>Send text</button></form><div>{['Tab', 'Enter', 'Backspace'].map(key => <button className="button ghost small" key={key} onClick={() => void control({ type: 'key', key })} disabled={busy}>{key}</button>)}<button className="button ghost small" onClick={() => void control({ type: 'scroll', delta: -600 })}>Scroll up</button><button className="button ghost small" onClick={() => void control({ type: 'scroll', delta: 600 })}>Scroll down</button></div><small>Click the current browser image to select a field or button. Text is sent directly to this browser, never to Codex or stored by the panel. Finishing releases browser control; it does not claim login succeeded.</small></div></section></div>;
}
