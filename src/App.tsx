import { useEffect, useRef, useState } from 'react';
import type { Draft } from '../server/types';
import { readCache, writeCache, clearCache } from './cache';
import { VerificationPrompt } from './VerificationPrompt';
import { Settings } from './Settings';
import { MyListings } from './MyListings';

async function api<T>(path: string, body?: unknown, method = 'GET', revision?: number): Promise<T> {
  const response = await fetch('/api' + path, { method, headers: { 'X-Linko-Request': '1', ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(revision === undefined ? {} : { 'If-Match': String(revision) }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  if (response.status === 401) window.dispatchEvent(new Event('linko-signed-out'));
  const data = await response.json(); if (!response.ok) throw new Error(data.message || 'This action could not be completed.'); return data;
}
const running = (d?: Draft) => !!d && ['queued', 'analyzing', 'preparing', 'publishing'].includes(d.state);
const locked = (d?: Draft) => running(d) || ['published', 'unknown'].includes(d?.state || '');
export function App() {
  const [draft, setDraft] = useState<Draft>(); const current = useRef<Draft | undefined>(undefined);
  const [dirty, setDirty] = useState(false), dirtyRef = useRef(false), version = useRef(0);
  const saving = useRef<Promise<Draft> | undefined>(undefined);
  const [working, setWorking] = useState(false), [saveFailed, setSaveFailed] = useState(false);
  const [online, setOnline] = useState(navigator.onLine), [error, setError] = useState('');
  const [section, setSection] = useState<'New listing' | 'Drafts' | 'My listings' | 'Settings'>('New listing');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; label: string; activeListings: number }[]>([]);
  const [cfg, setCfg] = useState<{ publishEnabled: boolean; mode: string }>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [categoryText, setCategoryText] = useState('');
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const blobs = useRef<{ id: string; blob: Blob }[]>([]), input = useRef<HTMLInputElement>(null);
  function show(d: Draft, pending = false, syncCategory = true) {
    if (syncCategory) setCategoryText(d.category.join(' > '));
    current.current = d; dirtyRef.current = pending; setDraft(d); setDirty(pending);
    sessionStorage.setItem('linko-draft', d.id);
  }
  async function refresh() {
    const [a, d] = await Promise.all([api<{ accounts: typeof accounts }>('/accounts'), api<{ drafts: Draft[] }>('/drafts')]);
    setAccounts(a.accounts); setDrafts(d.drafts);
  }
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    void (async () => {
      // A newly opened/duplicated tab may inherit sessionStorage from its opener.
      // Reloads resume that tab's draft; fresh navigation starts an independent one.
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navigator.onLine && navigation?.type === 'navigate') sessionStorage.removeItem('linko-draft');
      const activeId = sessionStorage.getItem('linko-draft');
      const cached = activeId ? await readCache(activeId).catch(() => undefined) : undefined;
      if (cached) {
        blobs.current = cached.photos;
        if (!navigator.onLine || cached.pending) show(cached.draft, cached.pending);
        setPreviews(Object.fromEntries(cached.photos.map(p => [p.id, URL.createObjectURL(p.blob)])));
      }
      if (!navigator.onLine) return;
      try {
        if (!cached?.pending) {
          const id = sessionStorage.getItem('linko-draft');
          let d: Draft | undefined;
          if (id) { try { d = await api<Draft>('/drafts/' + id); } catch {} }
          show(d || await api<Draft>('/drafts', {}, 'POST'));
        }
      } catch (e) { setError((e as Error).message); }
    })();
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (!online) return;
    void api<NonNullable<typeof cfg>>('/config').then(setCfg).catch(() => {});
    void refresh().catch(() => {});
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 3000);
    return () => clearInterval(timer);
  }, [online, section, refreshKey]);
  useEffect(() => {
    if (!draft) return;
    const id = draft.id;
    void writeCache({ draft, pending: dirty, photos: blobs.current.filter(p => draft.photos.some(v => v.id === p.id)) }).catch(() => setError('Device storage is full. Keep this page open until autosave completes.'));
    if (online) for (const p of draft.photos) if (!blobs.current.some(b => b.id === p.id)) {
      void fetch(`/api/drafts/${id}/photos/${p.id}`).then(r => { if (!r.ok) throw new Error(); return r.blob(); }).then(blob => {
        if (current.current?.id !== id || blobs.current.some(b => b.id === p.id)) return;
        blobs.current.push({ id: p.id, blob }); setPreviews(v => ({ ...v, [p.id]: URL.createObjectURL(blob) }));
        void writeCache({ draft: current.current, pending: dirtyRef.current, photos: blobs.current });
      }).catch(() => {});
    }
  }, [draft, dirty, online]);
  useEffect(() => {
    if (!online || !running(draft)) return;
    const id = draft!.id;
    const timer = setInterval(() => { void api<Draft>('/drafts/' + id).then(d => { if (current.current?.id === id) show(d); }).catch(e => setError(e.message)); }, 900);
    return () => clearInterval(timer);
  }, [online, draft?.id, draft?.state]);
  useEffect(() => {
    if (!dirty || !online || working || saveFailed || locked(draft)) return;
    const timer = setTimeout(() => { void save().catch(e => { setError(e.message); setSaveFailed(true); }); }, 500);
    return () => clearTimeout(timer);
  }, [draft, dirty, online, working, saveFailed]);
  function edit(key: keyof Draft, value: unknown) {
    if (!current.current || locked(current.current)) return;
    version.current++; show({ ...current.current, [key]: value }, true, key === 'category'); setSaveFailed(false);
  }
  async function save(): Promise<Draft> {
    if (saving.current) { await saving.current; return dirtyRef.current ? save() : current.current!; }
    const d = current.current; if (!d) throw new Error('Connect to create a draft.');
    if (!online || !dirtyRef.current) return d;
    const v = version.current;
    const { accountId, revision, title, description, price, currency, model, condition, location, category, facts, coverId } = d;
    const task = api<Draft>('/drafts/' + d.id, { accountId, revision, title, description, price, currency, model, condition, location, category, facts, coverId, photoOrder: d.photos.map(p => p.id) }, 'PATCH');
    saving.current = task;
    try {
      const next = await task;
      if (current.current?.id === d.id) {
        if (v === version.current) show(next, false, false);
        else show({ ...current.current, revision: next.revision }, true, false);
      }
      return next;
    } finally { saving.current = undefined; }
  }
  async function perform(fn: () => Promise<void>) {
    setWorking(true); setError('');
    try { await fn(); setRefreshKey(v => v + 1); } catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  }
  function reset(d: Draft) {
    Object.values(previews).forEach(url => URL.revokeObjectURL(url)); blobs.current = []; setPreviews({}); show(d); setSaveFailed(false);
  }
  async function open(id?: string) {
    await perform(async () => { if (!locked(current.current)) await save(); reset(await api<Draft>(id ? '/drafts/' + id : '/drafts', id ? undefined : {}, id ? 'GET' : 'POST')); setSection('New listing'); });
  }
  async function photos(files: FileList | null) {
    if (!files?.length) return;
    await perform(async () => {
      const d = await save();
      const form = new FormData(); Array.from(files).forEach(f => form.append('photos', f));
      show(await api<Draft>(`/drafts/${d.id}/photos`, form, 'POST', d.revision));
    });
    if (input.current) input.current.value = '';
  }
  async function action(op: 'analyze' | 'publish') {
    await perform(async () => {
      const d = await save();
      const result = await api<{ nextDraft?: Draft }>(`/drafts/${d.id}/${op}`, { revision: d.revision }, 'POST');
      if (result.nextDraft) reset(result.nextDraft);
      else show({ ...d, state: 'queued', message: 'Finding category…' });
    });
  }
  const disabled = working || locked(draft) || !draft;
  const basics = !!draft?.photos.length && !!draft.description.trim() && Number(draft.price) > 0;
  return <div className="lean-app">
    <header className="lean-header"><span className="lean-brand">linko.</span>{cfg?.mode === 'tailnet' && <button className="text-button" onClick={async () => { await api('/auth/logout', {}, 'POST'); await clearCache(); sessionStorage.removeItem('linko-draft'); window.dispatchEvent(new Event('linko-signed-out')); }}>Sign out of Linko panel</button>}</header>
    <nav className="lean-nav" aria-label="Main navigation">{(['New listing', 'Drafts', 'My listings', 'Settings'] as const).map(name => <button key={name} aria-current={section === name ? 'page' : undefined} onClick={() => setSection(name)}>{name}</button>)}</nav>
    <main className="lean-main">
      <div className="lean-heading"><h1>{section}</h1>{section === 'New listing' && <button className="button ghost" disabled={working || !online} onClick={() => void open()}>New draft</button>}</div>
      {!online && <p role="status">Offline mode</p>}
      {error && <div className="lean-error" role="alert">{error}{saveFailed && <button className="text-button" onClick={() => void perform(async () => { reset(await api<Draft>('/drafts/' + draft!.id)); })}>Reload saved draft</button>}</div>}
      {section === 'New listing' && <section className="panel lean-editor" aria-label="Listing editor">
        <fieldset disabled={disabled} className="lean-fields">
          <div className="lean-photos"><label className="photo-upload">Photos · {draft?.photos.length || 0}/8<input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={disabled || !online || (draft?.photos.length || 0) >= 8} onChange={e => void photos(e.target.files)}/></label>
            {!!draft?.photos.length && <div className="lean-photo-grid">{draft.photos.map((p, i) => <div className={'lean-photo ' + (p.id === draft.coverId ? 'cover' : '')} key={p.id}>
              <button className="photo-select" onClick={() => edit('coverId', p.id)} aria-label={`Use photo ${i + 1} as cover`} aria-pressed={p.id === draft.coverId}><img src={previews[p.id] || `/api/drafts/${draft.id}/photos/${p.id}`} alt={`Item photo ${i + 1}`}/></button>
              <span>{p.id === draft.coverId ? 'Cover' : `Photo ${i + 1}`}</span><div className="photo-tools">
                <button aria-label={`Move photo ${i + 1} earlier`} disabled={disabled || i === 0} onClick={() => { const next = [...draft.photos]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; edit('photos', next); }}>←</button>
                <button aria-label={`Move photo ${i + 1} later`} disabled={disabled || i === draft.photos.length - 1} onClick={() => { const next = [...draft.photos]; [next[i], next[i + 1]] = [next[i + 1], next[i]]; edit('photos', next); }}>→</button>
                <button aria-label={`Remove photo ${i + 1}`} disabled={disabled || !online} onClick={() => void perform(async () => { const d = await save(); show(await api<Draft>(`/drafts/${d.id}/photos/${p.id}`, undefined, 'DELETE', d.revision)); })}>×</button>
              </div></div>)}</div>}
          </div>
          <label>Listing title<input value={draft?.title || ''} maxLength={120} onChange={e => edit('title', e.target.value)}/></label>
          <label>Asking price<div className="price-input"><input aria-label="Asking price" inputMode="decimal" value={draft?.price || ''} onChange={e => edit('price', e.target.value)}/><select aria-label="Currency" value={draft?.currency || 'GEL'} onChange={e => edit('currency', e.target.value)}><option value="GEL">₾ GEL</option><option value="USD">$ USD</option></select></div></label>
          <label>Description<textarea aria-label="Description" rows={4} maxLength={6000} value={draft?.description || ''} onChange={e => edit('description', e.target.value)}/></label>
          <label>Listing account<select aria-label="Listing account" value={draft?.accountId || ''} onChange={e => edit('accountId', e.target.value)}><option value="" disabled>Choose account</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.label} · {a.activeListings} of 5 used</option>)}</select></label>
          <div className="category-row"><label>Category path<input value={categoryText} onChange={e => { edit('category', e.target.value.split('>').map(s => s.trim()).filter(Boolean)); setCategoryText(e.target.value); }}/></label><button className="button ghost" disabled={disabled || !online || !basics} onClick={() => void action('analyze')}>Find category</button></div>
          {!!draft?.categoryCandidates?.length && <fieldset className="category-choices"><legend>Choose a category</legend>{draft.categoryCandidates.map(path => <button className="button ghost" key={path.join(' > ')} onClick={() => edit('category', path)}>{path.join(' › ')}</button>)}</fieldset>}
          {!!draft?.questions.length && <div className="required-facts">{draft.questions.map(q => <label key={q.key}>{q.label}{q.options.length ? <select aria-label={q.label} value={draft.facts[q.key] || ''} onChange={e => edit('facts', { ...draft.facts, [q.key]: e.target.value })}><option value="">Choose</option>{q.options.map(o => <option key={o}>{o}</option>)}</select> : <input value={draft.facts[q.key] || ''} onChange={e => edit('facts', { ...draft.facts, [q.key]: e.target.value })}/>}</label>)}</div>}
        </fieldset>
        {(running(draft) || ['blocked', 'needs_input', 'unknown'].includes(draft?.state || '')) && <p role="status">{draft?.message}</p>}
        <div className="lean-publish"><span aria-live="polite">{dirty ? online ? 'Saving…' : 'Saved on this device' : 'Saved'}</span><button className="button primary" disabled={disabled || !online || !basics || !draft?.title.trim() || !draft.accountId || !cfg?.publishEnabled} onClick={() => void action('publish')}>Publish</button></div>
      </section>}
      {section === 'Drafts' && <section className="panel lean-drafts" aria-label="Drafts">{!drafts.length && <p>No drafts</p>}{drafts.map(d => <article key={d.id}><div><strong>{d.title || 'Untitled'}</strong><small>{d.state === 'needs_input' ? 'Needs details' : d.state}</small></div><button className="text-button" disabled={!online || working} onClick={() => void open(d.id)}>Resume {d.title || 'Untitled'}</button><button className="text-button" disabled={!online || working} onClick={() => void perform(async () => { const saved = d.id === current.current?.id ? await save() : d; await api(`/drafts/${d.id}?revision=${saved.revision}`, undefined, 'DELETE'); if (current.current?.id === d.id) reset(await api<Draft>('/drafts', {}, 'POST')); })}>Delete {d.title || 'Untitled'}</button></article>)}</section>}
      {section === 'My listings' && <MyListings online={online}/>}
      {section === 'Settings' && <Settings online={online} onSaved={() => { setRefreshKey(v => v + 1); }}/>}
    </main>
    {online && <VerificationPrompt/>}
  </div>;
}
