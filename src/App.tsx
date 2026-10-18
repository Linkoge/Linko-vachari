import { useEffect, useRef, useState } from 'react';
import type { Draft } from '../server/types';
import { readCache, writeCache, clearCache } from './cache';
import { BrowserPanel } from './BrowserPanel';
import { AgentWindow } from './AgentWindow';
import { Settings } from './Settings';
import { ListingRecords } from './ListingRecords';
type IconName = 'spark' | 'plus' | 'photo' | 'arrow' | 'check' | 'shield' | 'download' | 'close' | 'grid' | 'gear' | 'link' | 'leaf';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    spark: <><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/><path d="m20 2 .8 2.2L23 5l-2.2.8L20 8l-.8-2.2L17 5l2.2-.8Z"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, photo: <><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.4"/><path d="m4 18 5-5 3 3 4-6 5 7"/></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>, check: <path d="m5 12 4 4L19 6"/>, shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>, close: <path d="m6 6 12 12M6 18 18 6"/>, grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    gear: <><circle cx="12" cy="12" r="4"/><path d="m10 2-1 3-3 1-3 4 2 2-1 4 4 3 3-1 3 1 4-3-1-4 2-2-3-4-3-1-1-3Z"/></>, link: <><path d="m9 15 6-6m-7 4-2 2a4 4 0 0 0 6 6l3-3m1-7 2-2a4 4 0 0 0-6-6l-3 3"/></>, leaf: <><path d="M20 3C9 1 2 7 5 15s15 6 15-12Z"/><path d="M4 21 16 8"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
async function api<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch('/api' + path, { method, headers: { 'X-Linko-Request': '1', ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  if (response.status === 401) window.dispatchEvent(new Event('linko-signed-out'));
  const data = await response.json(); if (!response.ok) throw new Error(data.message || 'This action could not be completed.'); return data;
}
export function App() {
  const [draft, setDraft] = useState<Draft>(); const [dirty, setDirty] = useState(false); const [working, setWorking] = useState(false);
  const [online, setOnline] = useState(navigator.onLine); const [error, setError] = useState(''); const [step, setStep] = useState(1);
  const [settings, setSettings] = useState(false); const [browserOpen, setBrowserOpen] = useState(false); const [confirm, setConfirm] = useState(false); const [install, setInstall] = useState<any>();
  const [cfg, setCfg] = useState<{ everyday?: { signedIn: boolean }; codex: { available: boolean; chatgptSignedIn: boolean }; publishEnabled: boolean; mode: string; publicOrigin: string }>();
  const [previews, setPreviews] = useState<Record<string, string>>({}); const cachedPhotos = useRef<{ id: string; blob: Blob }[]>([]);
  const input = useRef<HTMLInputElement>(null); const draftRef = useRef(draft); draftRef.current = draft;
  const running = !!draft && ['analyzing', 'preparing', 'publishing'].includes(draft.state);
  const locked = running || ['published', 'unknown'].includes(draft?.state || '');
  useEffect(() => () => { draftRef.current = undefined; Object.values(previews).forEach(url => URL.revokeObjectURL(url)); }, []);
  useEffect(() => {
    if (!settings && !confirm) return;
    const prior = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLElement>('button')?.focus();
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSettings(false); setConfirm(false); }
      if (e.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea')).filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); prior?.focus(); };
  }, [settings, confirm]);
  useEffect(() => {
    if (online) void api<{ everyday?: { signedIn: boolean }; codex: { available: boolean; chatgptSignedIn: boolean }; publishEnabled: boolean; mode: string; publicOrigin: string }>('/config').then(setCfg).catch(() => {});
  }, [online]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update);
    const onInstall = (e: Event) => { e.preventDefault(); setInstall(e); }; window.addEventListener('beforeinstallprompt', onInstall);
    void (async () => {
      const cached = await readCache().catch(() => undefined);
      if (cached) { cachedPhotos.current = cached.photos; setDraft(cached.draft); setDirty(cached.pending); setPreviews(Object.fromEntries(cached.photos.map(p => [p.id, URL.createObjectURL(p.blob)]))); }
      if (!navigator.onLine) return;
      try {
        setCfg(await api('/config'));
        if (cached?.pending) { setError('You have locally saved edits. Save them to the workspace before continuing.'); return; }
        const next = cached ? await api<Draft>('/drafts/' + cached.draft.id) : await api<Draft>('/drafts', {}, 'POST'); setDraft(next);
      } catch (e) { setError(e instanceof Error ? e.message : 'Start the local Linko server to connect your workspace.'); }
    })();
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); window.removeEventListener('beforeinstallprompt', onInstall); };
  }, []);
  useEffect(() => {
    if (!draft) return;
    void writeCache({ draft, pending: dirty, photos: cachedPhotos.current.filter(p => draft.photos.some(v => v.id === p.id)) }).catch(() => setError('Device storage is full. Keep this page open and save to the workspace.'));
    if (online) for (const p of draft.photos) if (!cachedPhotos.current.some(v => v.id === p.id)) {
      void fetch(`/api/drafts/${draft.id}/photos/${p.id}`).then(r => { if (!r.ok) throw new Error('photo'); return r.blob(); }).then(blob => {
        if (cachedPhotos.current.some(v => v.id === p.id)) return;
        cachedPhotos.current.push({ id: p.id, blob }); setPreviews(v => ({ ...v, [p.id]: URL.createObjectURL(blob) }));
        const latest = draftRef.current; if (latest) void writeCache({ draft: latest, pending: dirty, photos: cachedPhotos.current });
      }).catch(() => {});
    }
  }, [draft, dirty, online]);
  useEffect(() => {
    if (!running || !draft) return;
    const timer = setInterval(() => { void api<Draft>('/drafts/' + draft.id).then(next => { setDraft(next); if (!['analyzing', 'preparing', 'publishing'].includes(next.state)) setStep(3); }).catch(() => setError('Connection interrupted. Reconnect to check this operation; do not repeat a publish request.')); }, 1400);
    return () => clearInterval(timer);
  }, [running, draft?.id]);
  function edit(key: keyof Draft, value: unknown) { if (locked) return; setDraft(d => d ? { ...d, [key]: value } : d); setDirty(true); }
  async function save(): Promise<Draft> {
    if (!draft) throw new Error('Connect to the local workspace to create a draft.');
    if (!online) { await writeCache({ draft, pending: true, photos: cachedPhotos.current }); setError('Saved on this device. Reconnect and save to the workspace before listing.'); return draft; }
    if (!dirty) return draft;
    const { revision, title, description, price, currency, model, condition, location, category, facts, coverId } = draft;
    const next = await api<Draft>('/drafts/' + draft.id, { revision, title, description, price, currency, model, condition, location, category, facts, coverId }, 'PATCH');
    setDraft(next); setDirty(false); return next;
  }
  async function action(op: 'analyze' | 'prepare' | 'publish') {
    setError(''); setWorking(true);
    try {
      const next = op === 'publish' ? draft! : await save();
      await api(`/drafts/${next.id}/${op}`, { revision: next.revision, confirm: op === 'publish', preparedAt: next.preparedAt }, 'POST');
      setDraft({ ...next, state: op === 'analyze' ? 'analyzing' : op === 'prepare' ? 'preparing' : 'publishing', message: op === 'publish' ? 'Submitting once to MyMarket…' : 'Connecting to the marketplace…' }); setStep(3); setConfirm(false);
    } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  async function photos(files: FileList | null) {
    if (!files?.length || !draft) return; setError(''); setWorking(true);
    try {
      if (!online) throw new Error('Photo uploads need a connection to your local workspace. Your existing photos and text stay available offline.');
      if (draft.photos.length + files.length > 8) throw new Error('Choose up to eight photos in total.');
      if (Array.from(files).some(f => !['image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size > 12 * 1024 * 1024)) throw new Error('Choose JPEG, PNG or WebP photos under 12 MB each.');
      const d = await save(); const form = new FormData(); Array.from(files).forEach(f => form.append('photos', f));
      setDraft(await api<Draft>(`/drafts/${d.id}/photos`, form, 'POST'));
    } catch (e) { setError((e as Error).message); } finally { setWorking(false); if (input.current) input.current.value = ''; }
  }
  async function remove(id: string) {
    setWorking(true); setError(''); try { const d = await save(); setDraft(await api<Draft>(`/drafts/${d.id}/photos/${id}`, undefined, 'DELETE')); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  async function newDraft() { setWorking(true); try { if (dirty && !locked) await save(); setDraft(await api<Draft>('/drafts', {}, 'POST')); setDirty(false); setStep(1); setError(''); cachedPhotos.current = []; } catch (e) { setError((e as Error).message); } finally { setWorking(false); } }
  const imageUrl = (id: string) => previews[id] || `/api/drafts/${draft?.id}/photos/${id}`;
  const hasBasics = !!draft?.photos.length && !!draft.description.trim() && Number(draft.price) > 0;
  return <div className="app-layout">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Linko home"><img src="/icons/icon-192.png" alt=""/><span>linko<span className="brand-dot">.</span><small>MYMARKETER</small></span></a>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <button className="nav-item active" onClick={() => setStep(1)}><Icon name="grid"/> Create a listing <span className="nav-dot"/></button>
      <button className="nav-item" onClick={() => setSettings(true)}><Icon name="gear"/> Connection & setup</button>
      <div className="sidebar-note"><div className="note-icon"><Icon name="leaf" size={25}/></div><h3>Good things deserve<br/>a second chapter.</h3><p>Less effort for you.<br/>More life for your things.</p><div className="note-line"/></div>
      <div className="sidebar-bottom"><span className="avatar">L</span><div>Local workspace<small>Private on this computer</small></div><Icon name="shield" size={17}/></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><button className="text-button settings-entry" onClick={() => setSettings(true)}>Settings</button><span className="breadcrumb">Workspace <span>/</span> <b>Create a listing</b></span><div className="top-actions"><span className={`connection ${!online ? 'offline' : ''}`}><i/>{online ? 'Local workspace' : 'Offline mode'}</span><button className="button small ghost" onClick={async () => { if (install) { await install.prompt(); setInstall(undefined); } else setError('Install Linko from your browser menu: “Install app” in Chrome, or Share → Add to Home Screen in Safari. Keep the local server running for marketplace operations.'); }}><Icon name="download" size={16}/> Install app</button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><span/> A LITTLE HELP, A GREAT LISTING</div><h1>Sell something good<span>.</span></h1><p>Your photos. A few details. We’ll take care of the busywork.</p></div><button className="button ghost new-draft" onClick={newDraft} disabled={working || running || !online}><Icon name="plus" size={17}/> New draft</button></div>
        {!online && <div className="notice">You’re offline. Edit and save your text on this device. Connect to your workspace to upload photos, analyze or publish.</div>}
        {cfg && !(cfg.everyday?.signedIn ?? cfg.codex.chatgptSignedIn) && <div className="setup-banner"><Icon name="link" size={18}/><span>Your draft is ready for you. Check your saved AI connection in Settings and sign in to MyMarket to prepare a listing.</span><button onClick={() => setSettings(true)}>Set up connection <Icon name="arrow" size={16}/></button></div>}
        {error && <div className="notice error" role="alert"><span>{error}</span><button aria-label="Dismiss message" onClick={() => setError('')}><Icon name="close" size={17}/></button></div>}
        <div className="steps" aria-label="Listing steps">{['Add photos', 'Item details', 'Review & list'].map((label, i) => <button key={label} onClick={() => setStep(i + 1)} className={step === i + 1 ? 'selected' : ''} aria-current={step === i + 1 ? 'step' : undefined}><span className="step-number">{i + 1}</span><span>{label}</span>{i < 2 && <span className="step-line"/>}</button>)}</div>
        <div className="editor-grid"><section className="editor">
          {step === 1 && <div className="panel"><div className="panel-heading"><div className="number-tag">01</div><div><h2>Start with the photos</h2><p>Show the whole item, then the little details.</p></div><span className="count-pill">{draft?.photos.length || 0} / 8</span></div>
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={e => void photos(e.target.files)} disabled={locked || working || !online || !draft}/>
            <button className="dropzone" onClick={() => input.current?.click()} disabled={locked || working || !online || !draft || (draft?.photos.length || 0) >= 8} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!locked && !working) void photos(e.dataTransfer.files); }}><span className="upload-icon"><Icon name="photo" size={31}/><span>+</span></span><strong>{working ? 'Taking care of your photos…' : 'Drop your photos here'}</strong><span>or <u>browse files</u> from your device</span><small>JPG, PNG or WebP · up to 12 MB each</small></button>
            {!!draft?.photos.length && <div className="photo-grid">{draft.photos.map((p, index) => <div className={'photo-tile ' + (p.id === draft.coverId ? 'cover' : '')} key={p.id}><button className="photo-select" disabled={locked || working} onClick={() => edit('coverId', p.id)} aria-label={`Use photo ${index + 1} as cover`}><img src={imageUrl(p.id)} alt={`Item photo ${index + 1}`}/></button><button className="photo-remove" aria-label={`Remove photo ${index + 1}`} disabled={locked || working || !online || !draft} onClick={() => void remove(p.id)}><Icon name="close" size={14}/></button><span className="cover-badge">{p.id === draft.coverId ? <><Icon name="spark" size={12}/> Cover photo</> : `Photo ${index + 1}`}</span></div>)}</div>}
            <div className="photo-tip"><span><Icon name="spark" size={20}/></span><div><strong>You choose the first impression</strong><p>Tap a photo to make it the main photo. We upload your choice first.</p></div></div>
            <div className="panel-footer"><span>Only your item. No filters needed.</span><button className="button primary" onClick={() => setStep(2)}>Add item details <Icon name="arrow" size={17}/></button></div>
          </div>}
          {step === 2 && <div className="panel"><div className="panel-heading"><div className="number-tag">02</div><div><h2>A few details go a long way</h2><p>Tell us what you know. We’ll ask for anything else.</p></div></div><div className="form-fields"><div className="field-row"><label>Asking price <span>*</span><div className="price-input"><input aria-label="Asking price" inputMode="decimal" value={draft?.price || ''} onChange={e => edit('price', e.target.value)} placeholder="0.00" disabled={locked || !draft}/><select aria-label="Currency" value={draft?.currency || 'GEL'} onChange={e => edit('currency', e.target.value)} disabled={locked || !draft}><option value="GEL">₾ GEL</option><option value="USD">$ USD</option></select></div></label><label>Model or item name <small>optional</small><input value={draft?.model || ''} onChange={e => edit('model', e.target.value)} placeholder="e.g. Canon EOS R50" maxLength={200} disabled={locked || !draft}/></label></div><label>Description <span>*</span><textarea value={draft?.description || ''} onChange={e => edit('description', e.target.value)} placeholder="What are you selling? Describe its condition, what’s included, and anything a buyer should know." rows={6} maxLength={6000} disabled={locked || !draft}/><small className="field-help">An honest description makes a better listing. We won’t guess specifications.</small></label><div className="field-row"><label>Condition <small>optional for now</small><select value={draft?.condition || ''} onChange={e => edit('condition', e.target.value)} disabled={locked || !draft}><option value="">Choose if known</option><option>New</option><option>Like new</option><option>Used</option><option>For parts / not working</option></select></label><label>City / location <small>optional for now</small><input value={draft?.location || ''} onChange={e => edit('location', e.target.value)} placeholder="e.g. Tbilisi" maxLength={200} disabled={locked || !draft}/></label></div></div><div className="panel-footer"><button className="text-button" onClick={() => setStep(1)}>Back to photos</button><button className="button primary" disabled={!hasBasics || locked || working || !online} onClick={() => void action('analyze')}><Icon name="spark" size={17}/> Find my category</button></div><p className="privacy-note"><Icon name="shield" size={14}/> Codex uses your item details and live page observations. Your photos are uploaded without analysis.</p></div>}
          {step === 3 && <div className="panel"><div className="panel-heading"><div className="number-tag">03</div><div><h2>Make it yours, then list it</h2><p>Review the details before they go to MyMarket.</p></div></div>
            {running && <div className="progress-card" role="status"><span className="spinner"/><div><strong>{draft?.state === 'publishing' ? 'Publishing your listing' : 'Your assistant is on it'}</strong><p>{draft?.message}</p></div></div>}
            {!running && draft?.message && <div className={`status-card ${draft.state === 'blocked' || draft.state === 'unknown' ? 'attention' : ''}`} role="status"><Icon name={draft.state === 'published' ? 'check' : 'spark'} size={20}/><p>{draft.message}</p></div>}
            <div className="form-fields"><label>Listing title <small>editable</small><input value={draft?.title || ''} onChange={e => edit('title', e.target.value)} placeholder="A clear title for your item" maxLength={120} disabled={locked || !draft}/></label><label>Category path <small>from live comparable listings</small><input value={draft?.category.join(' > ') || ''} onChange={e => edit('category', e.target.value.split('>').map(s => s.trim()).filter(Boolean))} placeholder="Analyze to find the current category" disabled={locked || !draft}/><small className="field-help">You can correct the path. We’ll match it to the live listing form.</small></label>
              {!!draft?.comparables.length && <div className="sources"><strong>How we found the category</strong>{draft.comparables.map(c => <a href={c.url} key={c.url} target="_blank" rel="noreferrer"><Icon name="link" size={14}/><span>{c.title}<small>{c.breadcrumbs.join(' › ')}</small></span><span>↗</span></a>)}</div>}
              {!!draft?.questions.length && <div className="missing-fields"><h3>Just a few things only you know</h3><p>These facts are required by the current marketplace form.</p>{draft.questions.map(q => <label key={q.key}>{q.label}{q.options.length ? <select value={draft.facts[q.key] || ''} disabled={locked || !draft} onChange={e => edit('facts', { ...draft.facts, [q.key]: e.target.value })}><option value="">Choose the correct detail</option>{q.options.map(o => <option key={o}>{o}</option>)}</select> : <input value={draft.facts[q.key] || ''} disabled={locked || !draft} onChange={e => edit('facts', { ...draft.facts, [q.key]: e.target.value })} placeholder="Enter the actual item detail"/>}</label>)}</div>}
              {!!draft?.fields.length && <div className="field-review"><h3>Values observed in the live form</h3>{draft.fields.map((f, i) => <div key={i}><span>{f.label}</span><strong>{f.value}</strong></div>)}<small>To change a value, edit your item details and prepare the form again.</small></div>}
              {draft?.receipt && <a className="receipt" href={draft.receipt.url} target="_blank" rel="noreferrer"><Icon name="check"/> View your published item <Icon name="arrow" size={17}/></a>}
              {!!draft?.events.length && <details className="activity"><summary>Listing activity · {draft.events.length} updates</summary><ol>{draft.events.map((event, i) => <li key={i}><time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{event.message}</li>)}</ol></details>}
            </div>
            <div className="panel-footer"><button className="text-button" onClick={() => setStep(2)}>Edit item details</button>{draft?.state === 'ready' && !dirty ? <button className="button primary" onClick={() => setConfirm(true)} disabled={working || !online || !cfg?.publishEnabled}>List on MyMarket <Icon name="arrow" size={17}/></button> : <button className="button primary" disabled={!hasBasics || !draft?.category.length || locked || working || !online} onClick={() => void action('prepare')}>Check live listing form <Icon name="arrow" size={17}/></button>}</div>
            {draft?.state === 'ready' && !cfg?.publishEnabled && <p className="privacy-note">Publishing is disabled in local configuration. Enable it and prepare again when you are ready to list a real item.</p>}
          </div>}
          <div className="reassurance"><Icon name="shield" size={17}/><span>You're in control. Nothing is published until you ask.</span></div>
        </section><aside className="preview-column"><div className="preview-heading"><span>YOUR LISTING, COMING TO LIFE</span><span className="live-dot"/></div><div className="listing-preview"><div className="preview-image">{draft?.coverId ? <img src={imageUrl(draft.coverId)} alt="Selected cover preview"/> : <div className="empty-preview"><span className="empty-orbit"/><span className="empty-photo"><Icon name="photo" size={54}/></span><span className="empty-spark"><Icon name="spark" size={29}/></span><p>A fresh start for<br/>something good.</p></div>}<span className="preview-tag">MyMarket preview</span>{draft?.condition && <span className="condition-tag">{draft.condition}</span>}</div><div className="preview-content"><div className="preview-category">{draft?.category.at(-1) || 'A category that fits'}</div><h3>{draft?.title || draft?.model || 'Your next great listing'}</h3><div className={'preview-price ' + (!draft?.price ? 'placeholder-price' : '')}>{draft?.price ? Number(draft.price).toLocaleString() : '—'} <span>{draft?.currency === 'USD' ? '$' : '₾'}</span></div><p>{draft?.description || 'Add a few details and give buyers a reason to love it.'}</p><div className="preview-meta"><span>{draft?.location || 'Your location'}</span><span>{draft?.photos.length || 0} photos</span></div></div></div><div className="assistant-card"><span className="assistant-icon"><Icon name="spark" size={21}/></span><div><h3>A helpful pair of hands</h3><p>We find similar items, match the category, and check the live form. You make the final call.</p></div></div><div className="save-status"><span className={dirty ? 'unsaved-dot' : 'saved-dot'}/>{dirty ? online ? 'Edits saved on this device' : 'Saved locally · sync when online' : 'Draft saved in your workspace'}<button disabled={working || locked} onClick={async () => { setWorking(true); try { await save(); } catch (e) { setError((e as Error).message); } finally { setWorking(false); } }}>{dirty ? 'Save' : 'Saved'}</button></div></aside></div>
        <ListingRecords online={online} disabled={working || running} onOpenDraft={async id => {
          if (dirty && !locked) await save();
          const next = await api<Draft>('/drafts/' + id);
          cachedPhotos.current = []; setDraft(next); setDirty(false); setStep(3); setError('');
        }}/>
        <footer className="page-footer"><span>Made for less scrolling and more selling.</span><span>Linko × MyMarket <span className="footer-spark">✦</span></span></footer>
      </main>
    </div>
    {online && <AgentWindow disabled={working || running} onOpenBrowser={async () => { setError(''); try { await api('/browser/start', {}, 'POST'); setBrowserOpen(true); } catch (e) { setError((e as Error).message); } }}/>}
    {browserOpen && <BrowserPanel onClose={() => setBrowserOpen(false)}/>}
    {settings && <div className="modal-backdrop" onClick={() => setSettings(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" onClick={e => e.stopPropagation()}><button className="modal-close" aria-label="Close setup" onClick={() => setSettings(false)}><Icon name="close"/></button><div className="modal-symbol"><Icon name="link" size={28}/></div><h2 id="setup-title">Your private connections</h2><p>The selected Everyday AI handles categories and field matching using its normal server sign-in. You choose the main photo. No provider key or photo analysis is used.</p><Settings online={online} onSaved={() => { void api<NonNullable<typeof cfg>>('/config').then(setCfg).catch(() => {}); }}/><div className="setup-status"><span>Access</span><strong>{cfg?.mode === 'tailnet' ? 'Protected Tailscale HTTPS' : 'Local workspace'}</strong></div><p>MyMarket login is separate from the Linko panel password. Open the assistant window, save your MyMarket details once, and it signs in for you; if MyMarket sends an SMS or email code, just type it into the assistant. The private browser below is only a fallback for a screen the assistant cannot handle.</p><button className="button primary" disabled={working || running || !online} onClick={async () => { setWorking(true); setError(''); try { await api('/browser/start', {}, 'POST'); setSettings(false); setBrowserOpen(true); } catch (e) { setError((e as Error).message); } finally { setWorking(false); } }}>Open private MyMarket browser <Icon name="arrow" size={17}/></button><small>The same private browser session is used for your listing workflow. Automation waits until you finish manual control. Existing session cookies stay only on this server.</small><div className="setup-status"><span>Real listing publishing</span><strong>{cfg?.publishEnabled ? 'Enabled' : 'Disabled by operator'}</strong></div>{cfg?.mode === 'tailnet' && <button className="button ghost" onClick={async () => { try { await api('/auth/logout', {}, 'POST'); await clearCache(); window.dispatchEvent(new Event('linko-signed-out')); } catch (e) { setError((e as Error).message); } }}>Sign out of Linko panel</button>}</section></div>}
    {confirm && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="publish-title"><button className="modal-close" aria-label="Cancel publishing" onClick={() => setConfirm(false)}><Icon name="close"/></button><div className="modal-symbol"><Icon name="spark" size={29}/></div><h2 id="publish-title">Ready for its next chapter?</h2><p>This publishes a real listing to your signed-in MyMarket account using the reviewed form. Check the actual values before continuing.</p><div className="confirmation-item"><strong>{draft?.title}</strong><span>{draft?.price} {draft?.currency}</span><small>{draft?.category.join(' › ')}</small></div><p>If the connection breaks during submission, we stop and ask you to check MyMarket before another attempt.</p><button className="button primary" disabled={working || dirty || !online} onClick={() => void action('publish')}>Publish this listing <Icon name="arrow" size={17}/></button><button className="text-button" onClick={() => setConfirm(false)}>Keep reviewing</button></section></div>}
  </div>;
}
