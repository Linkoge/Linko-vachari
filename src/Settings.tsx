import { useEffect, useState } from 'react';
import type { SettingsData, AIChoice, AISlot } from '../server/settings';
type Data = { ai: SettingsData['ai']; telegram: { configured: boolean; chatId: string }; providers: Record<AIChoice['provider'], { installed: boolean; signedIn: boolean; message: string }> };
async function request(path: string, body?: unknown, method = 'POST') {
  const r = await fetch('/api/settings' + path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Settings could not be saved.'); return data;
}
export function Settings({ online, onSaved }: { online: boolean; onSaved: () => void }) {
  const [data, setData] = useState<Data>(); const [ai, setAi] = useState<SettingsData['ai']>();
  const [token, setToken] = useState(''), [chatId, setChatId] = useState(''), [chatIds, setChatIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  async function load() { const d = await request(''); setData(d); setAi(d.ai); setChatId(d.telegram.chatId); }
  useEffect(() => { if (online) void load().catch(e => setError(e.message)); }, [online]);
  async function act(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  function choose(slot: AISlot, patch: Partial<AIChoice>) { if (ai) setAi({ ...ai, [slot]: { ...ai[slot], ...patch } }); }
  const dirty = JSON.stringify(ai) !== JSON.stringify(data?.ai);
  return <div className="connection-settings">
    <h3>AI</h3><p>Exactly two saved choices. Both use the CLI’s existing local sign-in. No provider key is used. Unavailable choices fail clearly without switching providers.</p>
    {ai && (['everyday','fixit'] as const).map(slot => <fieldset key={slot} disabled={busy || !online}>
      <legend>{slot === 'everyday' ? 'Everyday' : 'Fix-it'}</legend>
      <p>{slot === 'everyday' ? 'Category choice and field matching for new listings.' : 'Used only after a script step fails because the page changed.'}</p>
      <label>Provider<select aria-label={`${slot} provider`} value={ai[slot].provider} onChange={e => choose(slot, { provider: e.target.value as AIChoice['provider'] })}><option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option></select></label>
      <p role="status">{data?.providers[ai[slot].provider]?.message || 'Checking local sign-in…'}</p>
      <label>Model<input aria-label={`${slot} model`} value={ai[slot].model} onChange={e => choose(slot, { model: e.target.value })} maxLength={100} list={ai[slot].provider + '-models'}/></label>
      <label>Reasoning / effort<select aria-label={`${slot} effort`} value={ai[slot].effort} onChange={e => choose(slot, { effort: e.target.value as AIChoice['effort'] })}>{['low','medium','high'].map(e => <option key={e}>{e}</option>)}</select></label>
    </fieldset>)}
    <datalist id="codex-models"><option value="gpt-5.4-mini"/><option value="gpt-5.4"/></datalist><datalist id="claude-models"><option value="haiku"/><option value="sonnet"/><option value="opus"/></datalist>
    <button className="button primary" disabled={!ai || busy || !online || !dirty} onClick={() => void act(async () => { const saved = await request('/ai', ai, 'PUT'); setData(d => d && { ...d, ai: saved.ai }); setAi(saved.ai); onSaved(); setMessage('AI choices saved. Jobs use these exact choices.'); })}>Save AI choices</button>
    {dirty && ai && <p>Unsaved changes. Jobs continue using the saved choices until you save.</p>}
    <h3>Telegram</h3>
    <ol><li>Open Telegram, talk to <strong>@BotFather</strong>, use /newbot and copy the bot token below.</li><li>Open your new bot and press <strong>Start</strong>.</li><li>Save the token, then use <strong>Detect chat ID</strong> (getUpdates), choose your private chat and save again. Send a test message.</li></ol>
    <label>Bot token<input type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} placeholder={data?.telegram.configured ? 'Saved privately; leave blank to keep' : 'Paste bot token'} disabled={busy || !online}/></label>
    <label>Chat ID<input inputMode="text" value={chatId} onChange={e => setChatId(e.target.value)} disabled={busy || !online}/></label>
    <p>The token stays in the private data directory outside Git and is never returned or logged. Notification failures do not block monitoring.</p>
    <div className="settings-actions">
      <button className="button primary" disabled={busy || !online} onClick={() => void act(async () => { const saved = await request('/telegram', { ...(token ? { token } : {}), chatId }, 'PUT'); setToken(''); setData(d => d && { ...d, telegram: saved.telegram }); setMessage('Telegram settings saved privately.'); })}>Save Telegram</button>
      <button className="button ghost" disabled={busy || !online || !data?.telegram.configured} onClick={() => void act(async () => { const result = await request('/telegram/detect', {}); setChatIds(result.chatIds); if (result.chatIds.length === 1) setChatId(result.chatIds[0]); setMessage(result.chatIds.length ? 'Choose a detected chat ID and save Telegram.' : 'No private chat found. Press Start in your bot, send it a message, and try again.'); })}>Detect chat ID</button>
      <button className="button ghost" disabled={busy || !online || !data?.telegram.configured || !data?.telegram.chatId} onClick={() => void act(async () => { const result = await request('/telegram/test', {}); if (!result.sent) throw new Error('Test message could not be delivered. Check the saved token and chat ID.'); setMessage('Test message sent.'); })}>Send test message</button>
      {data?.telegram.configured && <button className="text-button" disabled={busy || !online} onClick={() => void act(async () => { const saved = await request('/telegram', { token: '', chatId: '' }, 'PUT'); setToken(''); setChatId(''); setData(d => d && { ...d, telegram: saved.telegram }); setMessage('Telegram disconnected.'); })}>Disconnect Telegram</button>}
    </div>
    {chatIds.length > 1 && <label>Detected private chats<select value={chatId} onChange={e => setChatId(e.target.value)}><option value="">Choose</option>{chatIds.map(id => <option key={id}>{id}</option>)}</select></label>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </div>;
}
