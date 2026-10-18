import { useEffect, useRef, useState } from 'react';
import type { SettingsData, AIChoice, AISlot } from '../server/settings';
import { AccountsSettings } from './AccountsSettings';
import { AIPicker } from './AIPicker';
type Data = { ai: SettingsData['ai']; telegram: { configured: boolean; chatId: string }; automation: SettingsData['automation'] };
async function request(path: string, body?: unknown, method = 'POST') {
  const r = await fetch('/api/settings' + path, { signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: JSON.stringify(body) }) });
  const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Settings could not be saved.'); return data;
}
export function Settings({ online, onSaved }: { online: boolean; onSaved: () => void }) {
  const [data, setData] = useState<Data>();
  const [token, setToken] = useState(''), [chatId, setChatId] = useState(''), [chatIds, setChatIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [aiStatus, setAiStatus] = useState('Loading settings');
  const saving = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (busy) return;
    const focused = restoreFocus.current; restoreFocus.current = null;
    // Restore after the enabled controls have committed; a frame scheduled in finally can run while the fieldset is still disabled.
    if (focused?.isConnected && (document.activeElement === document.body || document.activeElement === focused)) focused.focus({ preventScroll: true });
  }, [busy]);
  async function load() { const d = await request(''); setData(d); setChatId(d.telegram.chatId); setAiStatus('Saved choices'); }
  useEffect(() => { if (online) void load().catch(e => { setData(undefined); setAiStatus('Settings unavailable'); setError(e.message); }); }, [online]);
  async function act(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function choose(slot: AISlot, choice: AIChoice): Promise<boolean> {
    if (!data || saving.current || busy || !online) return false;
    const focused = document.activeElement as HTMLElement | null;
    saving.current = true; setBusy(true); setError(''); setAiStatus('Saving settings');
    try {
      const saved = await request('/ai', { ...data.ai, [slot]: choice }, 'PUT');
      setData(d => d && { ...d, ai: saved.ai }); setAiStatus('Settings saved'); onSaved(); return true;
    } catch (e) {
      setError('Model selection could not be confirmed. ' + (e as Error).message);
      // A lost response may still have committed. Re-read instead of displaying
      // a guessed rollback or allowing edits from an uncertain saved state.
      try { const saved = await request(''); setData(saved); onSaved(); setAiStatus('Saved choices restored'); }
      catch { setData(undefined); setAiStatus('Settings unavailable. Reconnect or retry to load saved choices.'); }
      return false;
    } finally {
      restoreFocus.current = focused; saving.current = false; setBusy(false);
    }
  }
  async function toggle(key: keyof SettingsData['automation']) {
    if (!data || busy || !online) return;
    await act(async () => {
      try {
        const saved = await request('/automation', { ...data.automation, [key]: !data.automation[key] }, 'PUT');
        setData(d => d && { ...d, automation: saved.automation }); onSaved();
      } catch (e) {
        try { await load(); onSaved(); } catch { setData(undefined); }
        throw e;
      }
    });
  }
  return <div className="connection-settings">
    <AccountsSettings online={online} onSaved={onSaved}/>
    <div className="ai-heading"><h3>AI</h3><span role="status" aria-live="polite">{online ? aiStatus : 'Offline · saved choices cannot be changed'}</span></div>
    <div className="ai-picker" aria-busy={busy}>
      {data && (['everyday','fixit'] as const).map(slot => <AIPicker key={slot} slot={slot} choice={data.ai[slot]} disabled={busy || !online}
        onChoose={choice => choose(slot, choice)}/>)}
    </div>
    {!data && <button className="button ghost" disabled={busy || !online} onClick={() => void act(load)}>Retry settings</button>}
    {error && <p role="alert">{error}</p>}
    <section aria-label="Telegram"><h3>Telegram</h3>
    <label>Bot token<input type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} placeholder={data?.telegram.configured ? 'Saved privately; leave blank to keep' : 'Paste bot token'} disabled={busy || !online}/></label>
    <label>Chat ID<input inputMode="text" value={chatId} onChange={e => setChatId(e.target.value)} disabled={busy || !online}/></label>
    <div className="settings-actions">
      <button className="button primary" disabled={busy || !online} onClick={() => void act(async () => { const saved = await request('/telegram', { ...(token ? { token } : {}), chatId }, 'PUT'); setToken(''); setData(d => d && { ...d, telegram: saved.telegram }); setMessage('Telegram saved.'); })}>Save Telegram</button>
      <button className="button ghost" disabled={busy || !online || !data?.telegram.configured} onClick={() => void act(async () => { const result = await request('/telegram/detect', {}); setChatIds(result.chatIds); if (result.chatIds.length === 1) setChatId(result.chatIds[0]); setMessage(result.chatIds.length ? 'Choose a detected chat ID and save Telegram.' : 'No private chat found. Press Start in your bot, send it a message, and try again.'); })}>Detect chat ID</button>
      <button className="button ghost" disabled={busy || !online || !data?.telegram.configured || !data?.telegram.chatId} onClick={() => void act(async () => { const result = await request('/telegram/test', {}); if (!result.sent) throw new Error('Test message could not be delivered. Check the saved token and chat ID.'); setMessage('Test message sent.'); })}>Send test message</button>
      {data?.telegram.configured && <button className="text-button" disabled={busy || !online} onClick={() => void act(async () => { const saved = await request('/telegram', { token: '', chatId: '' }, 'PUT'); setToken(''); setChatId(''); setData(d => d && { ...d, telegram: saved.telegram }); setMessage('Telegram disconnected.'); })}>Disconnect Telegram</button>}
    </div>
    {chatIds.length > 1 && <label>Detected private chats<select value={chatId} onChange={e => setChatId(e.target.value)}><option value="">Choose</option>{chatIds.map(id => <option key={id}>{id}</option>)}</select></label>}
    {message && <p role="status">{message}</p>}
    </section>
    <section className="automation-settings" aria-label="Automation">
      <label><input type="checkbox" checked={data?.automation.publish || false} disabled={!data || busy || !online} onChange={() => void toggle('publish')}/>Publish</label>
      <label><input type="checkbox" checked={data?.automation.autoRelist || false} disabled={!data || busy || !online} onChange={() => void toggle('autoRelist')}/>Auto-relist</label>
    </section>
  </div>;
}
