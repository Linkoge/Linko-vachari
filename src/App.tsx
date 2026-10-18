import { useEffect, useRef, useState } from 'react';
import type { Draft } from '../server/types';
import { readCache, writeCache, clearCache } from './cache';
import { VerificationPrompt } from './VerificationPrompt';
import { Settings } from './Settings';
import { MyListings } from './MyListings';
import { accountField, defaultCity } from '../server/required-info';
import { mergePhotoAppend, RequestError, uploadPhoto } from './photo-uploads';

async function api<T>(path: string, body?: unknown, method = 'GET', revision?: number): Promise<T> {
  const response = await fetch('/api' + path, { method, headers: { 'X-Linko-Request': '1', ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(revision === undefined ? {} : { 'If-Match': String(revision) }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  if (response.status === 401) window.dispatchEvent(new Event('linko-signed-out'));
  const data = await response.json(); if (!response.ok) throw new RequestError(data.message || 'This action could not be completed.', response.status, data.code); return data;
}
const running = (d?: Draft) => !!d && ['queued', 'analyzing', 'preparing', 'publishing'].includes(d.state);
const locked = (d?: Draft) => running(d) || ['published', 'unknown'].includes(d?.state || '');
export function App() {
  const [draft, setDraft] = useState<Draft>(); const current = useRef<Draft | undefined>(undefined);
  const [dirty, setDirty] = useState(false), dirtyRef = useRef(false), version = useRef(0);
  const saving = useRef<Promise<Draft> | undefined>(undefined);
  const confirmed = useRef<Draft | undefined>(undefined);
  type Upload = { id: string; name: string; preview: string; progress: number };
  const [uploads, setUploads] = useState<Upload[]>([]), pendingUploads = useRef<Upload[]>([]);
  const [working, setWorking] = useState(false), [saveFailed, setSaveFailed] = useState(false);
  const [online, setOnline] = useState(navigator.onLine), [error, setError] = useState('');
  const [section, setSection] = useState<'New listing' | 'Drafts' | 'My listings' | 'Settings'>('New listing');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; label: string; activeListings: number; defaults: { location: string; phone: string } }[]>([]);
  const [cfg, setCfg] = useState<{ publishEnabled: boolean; mode: string }>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [categoryText, setCategoryText] = useState('');
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const blobs = useRef<{ id: string; blob: Blob }[]>([]), input = useRef<HTMLInputElement>(null);
  function show(d: Draft, pending = false, syncCategory = true) {
    if (!pending) confirmed.current = d;
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
      const linkedId = /^#draft\/([a-f0-9-]+)$/.exec(window.location.hash)?.[1];
      if (linkedId) sessionStorage.setItem('linko-draft', linkedId);
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
  const listingAccount = accounts.find(a => a.id === draft?.accountId);
  async function saveDefault(field: 'location' | 'phone', value: string) {
    if (!listingAccount) return;
    await perform(async () => {
      await api(`/settings/accounts/${listingAccount.id}/defaults`, { location: listingAccount.defaults?.location || defaultCity, phone: listingAccount.defaults?.phone || '', [field]: value }, 'PUT');
      await refresh();
    });
  }
  async function save(): Promise<Draft> {
    if (saving.current) { await saving.current; return dirtyRef.current ? save() : current.current!; }
    const d = current.current; if (!d) throw new Error('Connect to create a draft.');
    if (!online || !dirtyRef.current) return d;
    const task = (async () => {
      for (let attempt = 0; ; attempt++) {
        const snapshot = current.current!; const v = version.current;
        const { accountId, revision, title, description, price, currency, model, condition, location, category, facts, coverId } = snapshot;
        try {
          const next = await api<Draft>('/drafts/' + snapshot.id, { accountId, revision, title, description, price, currency, model, condition, location, category, facts, coverId, photoOrder: snapshot.photos.map(p => p.id) }, 'PATCH');
          if (current.current?.id === snapshot.id) {
            if (v === version.current) show(next, false, false);
            else show({ ...current.current, revision: next.revision }, true, false);
            confirmed.current = next;
          }
          return next;
        } catch (e) {
          if (!(e instanceof RequestError) || e.code !== 'CONFLICT' || attempt >= 8 || current.current?.id !== snapshot.id) throw e;
          acceptPhotos(await api<Draft>('/drafts/' + snapshot.id));
        }
      }
    })();
    saving.current = task;
    try { return await task; } finally { saving.current = undefined; }
  }
  function acceptPhotos(next: Draft) {
    const local = current.current, base = confirmed.current;
    if (!local || !base || local.id !== next.id || next.revision <= base.revision) return;
    const merged = mergePhotoAppend(base, local, next);
    show(merged, dirtyRef.current, false); confirmed.current = next;
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
    const d = current.current;
    if (!files?.length || !d) return;
    const selected = Array.from(files);
    if (input.current) input.current.value = '';
    if (d.photos.length + pendingUploads.current.length + selected.length > 8) { setError('Add between one and eight photos in total.'); return; }
    const pending = selected.map(file => ({ id: crypto.randomUUID(), name: file.name, preview: URL.createObjectURL(file), progress: 0 }));
    pendingUploads.current = [...pendingUploads.current, ...pending]; setUploads(pendingUploads.current); setError('');
    // Keep each selection's gallery order and initial cover. Another selection
    // may upload concurrently, and text saves never wait for this loop.
    for (const [i, photo] of pending.entries()) {
      try {
        for (let attempt = 0; ; attempt++) {
          let next: Draft;
          try {
            next = await uploadPhoto(d.id, selected[i], confirmed.current?.id === d.id ? confirmed.current.revision : d.revision, progress => {
              pendingUploads.current = pendingUploads.current.map(p => p.id === photo.id ? { ...p, progress } : p); setUploads(pendingUploads.current);
            });
          } catch (e) {
            if (!(e instanceof RequestError) || e.code !== 'CONFLICT' || attempt >= 8 || current.current?.id !== d.id) throw e;
            await saving.current;
            const latest = await api<Draft>('/drafts/' + d.id);
            await saving.current;
            acceptPhotos(latest);
            continue;
          }
          // A save response establishes the text baseline before adopting a
          // photo response that may already include that save's revision.
          await saving.current;
          acceptPhotos(next); break;
        }
      } catch (e) {
        setError((e as Error).message);
        if (e instanceof RequestError && e.code === 'CONFLICT') setSaveFailed(true);
      } finally {
        URL.revokeObjectURL(photo.preview);
        pendingUploads.current = pendingUploads.current.filter(p => p.id !== photo.id); setUploads(pendingUploads.current);
        setRefreshKey(v => v + 1);
      }
    }
  }
  async function action(op: 'analyze' | 'publish') {
    if (pendingUploads.current.length) return;
    await perform(async () => {
      const d = await save();
      const result = await api<{ nextDraft?: Draft }>(`/drafts/${d.id}/${op}`, { revision: d.revision }, 'POST');
      if (result.nextDraft) reset(result.nextDraft);
      else show({ ...d, state: 'queued', message: 'Finding category…' });
    });
  }
  const disabled = working || locked(draft) || !draft;
  const uploading = uploads.length > 0;
  const basics = !!draft?.photos.length && !!draft.description.trim() && Number(draft.price) > 0;
  const publishReason = !online ? 'Reconnect to publish' : !draft ? 'Loading draft…' : uploading ? 'Uploading photos…' : working ? 'Wait for the current action to finish' : running(draft) ? 'This listing is being processed' : draft.state === 'unknown' ? 'Check this submission on MyMarket before continuing' : draft.state === 'published' ? 'This listing is already published' : !cfg ? 'Checking publishing settings…' : !cfg.publishEnabled ? 'Publishing is off' : saveFailed ? 'Reload the saved draft before publishing' : !draft.photos.length ? 'Add at least one photo' : !draft.title.trim() ? 'Add a listing title' : !draft.description.trim() ? 'Add a description' : !(Number(draft.price) > 0) ? 'Enter a price greater than zero' : !draft.accountId ? 'Choose a listing account' : '';
  return <div className="lean-app">
    <header className="lean-header"><span className="lean-brand">linko.</span>{cfg?.mode === 'tailnet' && <button className="text-button" onClick={async () => { await api('/auth/logout', {}, 'POST'); await clearCache(); sessionStorage.removeItem('linko-draft'); window.dispatchEvent(new Event('linko-signed-out')); }}>Sign out of Linko panel</button>}</header>
    <nav className="lean-nav" aria-label="Main navigation">{(['New listing', 'Drafts', 'My listings', 'Settings'] as const).map(name => <button key={name} aria-current={section === name ? 'page' : undefined} onClick={() => setSection(name)}>{name}</button>)}</nav>
    <main className="lean-main">
      <div className="lean-heading"><h1>{section}</h1>{section === 'New listing' && <button className="button ghost" disabled={working || uploading || !online} onClick={() => void open()}>New draft</button>}</div>
      {!online && <p role="status">Offline mode</p>}
      {error && <div className="lean-error" role="alert">{error}{saveFailed && <button className="text-button" onClick={() => void perform(async () => { reset(await api<Draft>('/drafts/' + draft!.id)); })}>Reload saved draft</button>}</div>}
      {section === 'New listing' && <section className="panel lean-editor" aria-label="Listing editor">
        <fieldset disabled={disabled} className="lean-fields">
          <div className="lean-photos"><label className="photo-upload">Photos · {(draft?.photos.length || 0) + uploads.length}/8<input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={disabled || !online || (draft?.photos.length || 0) + uploads.length >= 8} onChange={e => void photos(e.target.files)}/></label>
            {!!draft?.photos.length && <div className="lean-photo-grid">{draft.photos.map((p, i) => <div className={'lean-photo ' + (p.id === draft.coverId ? 'cover' : '')} key={p.id}>
              <button className="photo-select" onClick={() => edit('coverId', p.id)} aria-label={`Use photo ${i + 1} as cover`} aria-pressed={p.id === draft.coverId}><img src={previews[p.id] || `/api/drafts/${draft.id}/photos/${p.id}`} alt={`Item photo ${i + 1}`}/></button>
              <span>{p.id === draft.coverId ? 'Cover' : `Photo ${i + 1}`}</span><div className="photo-tools">
                <button aria-label={`Move photo ${i + 1} earlier`} disabled={disabled || i === 0} onClick={() => { const next = [...draft.photos]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; edit('photos', next); }}>←</button>
                <button aria-label={`Move photo ${i + 1} later`} disabled={disabled || i === draft.photos.length - 1} onClick={() => { const next = [...draft.photos]; [next[i], next[i + 1]] = [next[i + 1], next[i]]; edit('photos', next); }}>→</button>
                <button aria-label={`Remove photo ${i + 1}`} disabled={disabled || uploading || !online} onClick={() => void perform(async () => { const d = await save(); show(await api<Draft>(`/drafts/${d.id}/photos/${p.id}`, undefined, 'DELETE', d.revision)); })}>×</button>
              </div></div>)}</div>}
            {!!uploads.length && <div className="lean-photo-grid">{uploads.map(p => <div className="lean-photo pending-photo" key={p.id}>
              <img src={p.preview} alt={`Uploading ${p.name}`}/><span>{p.progress === 100 ? 'Saving photo…' : `Uploading… ${p.progress}%`}</span>
              <progress aria-label={`Upload progress for ${p.name}`} max={100} value={p.progress}/>
            </div>)}</div>}
          </div>
          <label>Listing title<input value={draft?.title || ''} maxLength={120} onChange={e => edit('title', e.target.value)}/></label>
          <label>Asking price<div className="price-input"><input aria-label="Asking price" inputMode="decimal" value={draft?.price || ''} onChange={e => edit('price', e.target.value)}/><select aria-label="Currency" value={draft?.currency || 'GEL'} onChange={e => edit('currency', e.target.value)}><option value="GEL">₾ GEL</option><option value="USD">$ USD</option></select></div></label>
          <label>Description<textarea aria-label="Description" rows={4} maxLength={6000} value={draft?.description || ''} onChange={e => edit('description', e.target.value)}/></label>
          <label>Listing account<select aria-label="Listing account" value={draft?.accountId || ''} onChange={e => { edit('location', accounts.find(a => a.id === e.target.value)?.defaults?.location || defaultCity); edit('accountId', e.target.value); }}><option value="" disabled>Choose account</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.label} · {a.activeListings} of 5 used</option>)}</select></label>
          <label className="listing-location">City<input maxLength={200} value={draft?.location || listingAccount?.defaults?.location || defaultCity} onChange={e => edit('location', e.target.value)}/></label>
          <div className="category-row"><label>Category path<input value={categoryText} onChange={e => { edit('category', e.target.value.split('>').map(s => s.trim()).filter(Boolean)); setCategoryText(e.target.value); }}/></label><button className="button ghost" disabled={disabled || uploading || !online || !basics} aria-describedby={uploading ? 'photo-upload-reason' : undefined} onClick={() => void action('analyze')}>Find category</button></div>
          {uploading && <p id="photo-upload-reason" role="status">Uploading photos…</p>}
          {!!draft?.categoryCandidates?.length && <fieldset className="category-choices"><legend>Choose a category</legend>{draft.categoryCandidates.map(path => <button className="button ghost" key={path.join(' > ')} onClick={() => edit('category', path)}>{path.join(' › ')}</button>)}</fieldset>}
          {!!draft?.questions.length && <div className="required-facts" aria-label="Required information"><p>Needs info · answer below, then press Publish.</p>{draft.questions.map(q => {
            const field = accountField(q), value = field === 'location' ? draft.location || listingAccount?.defaults?.location || defaultCity : field === 'phone' ? draft.facts[q.key] || draft.facts.phone || '' : draft.facts[q.key] || '';
            const answer = (v: string) => {
              if (field === 'location') edit('location', v);
              else { const facts = { ...current.current!.facts, [field === 'phone' ? 'phone' : q.key]: v }; if (field === 'phone' && q.key !== 'phone') delete facts[q.key]; edit('facts', facts); }
            };
            return <div key={q.key}><label>{q.label}{q.options.length ? <select aria-label={q.label} value={value} onChange={e => answer(e.target.value)}><option value="">Choose</option>{q.options.map(o => <option key={o}>{o}</option>)}</select> : <input aria-label={q.label} type={field === 'phone' ? 'tel' : 'text'} value={value} placeholder={field === 'phone' && listingAccount?.defaults?.phone ? 'Saved account phone will be used' : ''} onChange={e => answer(e.target.value)}/>}</label>
              {field && <button className="text-button" disabled={disabled || !online || !value.trim() || !listingAccount} onClick={() => void saveDefault(field, value)}>Save as account default {field === 'phone' ? 'phone' : 'city'}</button>}
            </div>;
          })}</div>}
        </fieldset>
        {(running(draft) || ['blocked', 'needs_input', 'unknown'].includes(draft?.state || '')) && <p role="status">{draft?.message}</p>}
        <div className="lean-publish"><span aria-live="polite">{dirty ? online ? 'Saving…' : 'Saved on this device' : 'Saved'}</span><div className="publish-action">{publishReason && <p id="publish-reason" aria-live="polite">{publishReason}{publishReason === 'Publishing is off' && <> — turn it on in <a href="#settings" onClick={e => { e.preventDefault(); setSection('Settings'); }}>Settings</a></>}</p>}<button className="button primary" disabled={!!publishReason} aria-describedby={publishReason ? 'publish-reason' : undefined} onClick={() => void action('publish')}>Publish</button></div></div>
      </section>}
      {section === 'Drafts' && <section className="panel lean-drafts" aria-label="Drafts">{!drafts.length && <p>No drafts</p>}{drafts.map(d => <article key={d.id}><div><strong>{d.title || 'Untitled'}</strong><small>{d.state === 'needs_input' ? 'Needs details' : d.state}</small></div><button className="text-button" disabled={!online || working || uploading} onClick={() => void open(d.id)}>Resume {d.title || 'Untitled'}</button><button className="text-button" disabled={!online || working || uploading} onClick={() => void perform(async () => { const saved = d.id === current.current?.id ? await save() : d; await api(`/drafts/${d.id}?revision=${saved.revision}`, undefined, 'DELETE'); if (current.current?.id === d.id) reset(await api<Draft>('/drafts', {}, 'POST')); })}>Delete {d.title || 'Untitled'}</button></article>)}</section>}
      {section === 'My listings' && <MyListings online={online} onOpen={id => void open(id)}/>}
      {section === 'Settings' && <Settings online={online} onSaved={() => { setRefreshKey(v => v + 1); }}/>}
    </main>
    {online && <VerificationPrompt/>}
  </div>;
}
