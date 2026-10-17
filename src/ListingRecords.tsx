import { useEffect, useState } from 'react';
import type { ListingRecord } from '../server/listings';

type RecordSummary = Omit<ListingRecord, 'recipe'> & { title: string };
export function ListingRecords({ online, onOpenDraft, disabled }: { online: boolean; onOpenDraft: (id: string) => Promise<void>; disabled: boolean }) {
  const [data, setData] = useState<{ autoRelistEnabled: boolean; records: RecordSummary[] }>();
  const [error, setError] = useState('');
  async function refresh() {
    const response = await fetch('/api/listings');
    if (!response.ok) return;
    setData(await response.json());
  }
  useEffect(() => {
    if (!online) return;
    void refresh().catch(() => {});
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 30_000);
    return () => clearInterval(timer);
  }, [online]);
  async function change(id: string, enabled: boolean) {
    setError('');
    try {
      const response = await fetch('/api/listings/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Linko-Request': '1' }, body: JSON.stringify({ enabled }) });
      if (!response.ok) throw new Error((await response.json()).message);
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }
  if (!data?.records.length) return null;
  return <section className="panel listing-records" aria-label="Saved listings">
    <details><summary>Saved listings · {data.records.length}</summary>
      <p>Checks run every three hours while the server is running. Automatic re-listing is {data.autoRelistEnabled ? 'enabled' : 'disabled in server configuration'}. Pause monitoring before selling or intentionally removing an item.</p>
      {error && <p role="alert">{error}</p>}
      {data.records.map(r => <article key={r.id}>
        <h3>{r.title}</h3><p>{r.enabled ? r.status : 'Paused'} · {r.message}</p>
        <p>{r.checkedAt ? `Last checked: ${new Date(r.checkedAt).toLocaleString()}` : 'Not checked yet'}</p>
        <a href={`/api/listings/${r.id}/record`}>Download Markdown record</a>{' · '}
        {r.receipt && <><a href={r.receipt.url} target="_blank" rel="noreferrer">Open listing</a>{' · '}</>}
        <button className="text-button" disabled={!online || disabled} onClick={() => { void onOpenDraft(r.replacementId || r.id).catch(e => setError((e as Error).message)); }}>Open draft</button>{' · '}
        <button className="text-button" disabled={!online || ['replaced', 'relisting'].includes(r.status)} onClick={() => void change(r.id, !r.enabled)}>{r.enabled ? 'Pause monitoring' : 'Resume monitoring'}</button>
      </article>)}
    </details>
  </section>;
}
