import { useEffect, useRef, useState } from 'react';
import type { ListingSummary } from '../server/listing-summary';

export function MyListings({ online, onOpen }: { online: boolean; onOpen: (id: string) => void }) {
  const [listings, setListings] = useState<ListingSummary[]>(), [error, setError] = useState('');
  const [deleting, setDeleting] = useState<ListingSummary>(), [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  async function refresh() {
    const r = await fetch('/api/listings', { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error('Listings could not be loaded.');
    setListings((await r.json()).listings);
  }
  useEffect(() => {
    if (!online) return;
    const load = () => void refresh().catch(e => setError(e.message));
    load(); const timer = setInterval(load, 1500); return () => clearInterval(timer);
  }, [online]);
  useEffect(() => { if (deleting) dialog.current?.showModal(); else dialog.current?.close(); }, [deleting]);
  async function remove() {
    if (!deleting || pending) return;
    setPending(true); setError('');
    try {
      const r = await fetch(`/api/listings/${deleting.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: JSON.stringify({ confirm: true }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Deletion could not be completed.');
      setDeleting(undefined); await refresh();
    } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }
  return <section className="panel my-listings" aria-label="My listings">
    {error && !deleting && <p role="alert">{error}</p>}
    {!listings ? <p role="status">{online ? 'Loading…' : 'Connect to load listings.'}</p> : !listings.length && <p>No listings yet.</p>}
    {listings?.map(l => <article key={l.id} aria-label={l.title} className="listing-row">
      {l.cover ? <img className="listing-cover" src={l.cover} alt={`Cover of ${l.title}`}/> : <div className="listing-cover" aria-label="No cover photo"/>}
      <div className="listing-info"><h2>{l.title}</h2><p>{l.price} {l.currency}</p><p>{l.account}</p><span className="listing-status">{l.status === 'needs_input' ? 'Needs info' : l.status}</span>{l.reason && <p>{l.reason}</p>}</div>
      <div className="listing-actions">{l.url ? <a href={l.url} target="_blank" rel="noreferrer">MyMarket</a> : <span aria-disabled="true">MyMarket</span>}
        {l.draftId && <a href={'#draft/' + l.draftId} onClick={e => { e.preventDefault(); if (online) onOpen(l.draftId!); }} aria-disabled={!online}>Open draft</a>}
        <button className="text-button" disabled={!online || pending || !l.canDelete} onClick={() => { setError(''); setDeleting(l); }}>Delete</button></div>
    </article>)}
    <dialog ref={dialog} className="modal" aria-labelledby="delete-title" onCancel={e => { if (pending) e.preventDefault(); else setDeleting(undefined); }}>
      <h2 id="delete-title">Delete {deleting?.title}?</h2><p>{deleting?.status === 'queued' ? 'Cancel publication of this listing?' : 'Delete on MyMarket and stop auto-relisting?'}</p>
      {error && <p role="alert">{error}</p>}
      <div className="settings-actions"><button className="button ghost" autoFocus disabled={pending} onClick={() => setDeleting(undefined)}>Cancel</button><button className="button primary" disabled={pending || !online} onClick={() => void remove()}>{pending ? 'Deleting…' : 'Confirm deletion'}</button></div>
    </dialog>
  </section>;
}
