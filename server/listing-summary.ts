import type { Workflow } from './workflow';
import type { PublishQueue } from './queue';
import type { Draft } from './types';
import type { ListingRecord } from './listings';

export interface ListingSummary {
  id: string; title: string; price: string; currency: string; account: string;
  status: 'queued' | 'publishing' | 'live' | 'failed' | 'deleted-by-me' | 'relisted';
  cover?: string; url?: string; canDelete: boolean;
}

/** One row per listing, including retries, older receipts and replacement history. */
export function myListings(flow: Workflow, queue: PublishQueue): ListingSummary[] {
  const drafts = new Map<string, Draft>();
  const jobs = new Map(queue.all().filter(j => j.operation === 'submit').map(j => [j.draft, j]));
  for (const d of flow.store.all()) if (jobs.has(d.id) || ['published', 'unknown', 'publishing'].includes(d.state)) drafts.set(d.id, d);
  const records = new Map<string, ListingRecord>();
  for (const r of flow.archive.all()) { records.set(r.id, r); if (!drafts.has(r.id)) drafts.set(r.id, r.recipe); }
  return [...drafts.values()].map(d => {
    const record = records.get(d.id), job = jobs.get(d.id), recipe = record?.recipe || d;
    const receipt = record?.receipt || d.receipt;
    let status: ListingSummary['status'] = 'failed';
    if (record?.status === 'deleted_by_owner') status = 'deleted-by-me';
    else if (record?.deleteRequestedAt || ['attention', 'missing', 'unavailable'].includes(record?.status || '')) status = 'failed';
    else if (record?.status === 'replaced') status = 'relisted';
    else if (record?.status === 'relisting' || job?.status === 'running' || d.state === 'publishing') status = 'publishing';
    else if (job?.status === 'queued') status = 'queued';
    else if (receipt) status = 'live';
    const photo = recipe.photos.find(p => p.id === recipe.coverId) || recipe.photos[0];
    return { id: d.id, title: recipe.title || 'Untitled', price: recipe.price, currency: recipe.currency,
      account: flow.accounts.label(recipe.accountId || 'legacy'), status,
      cover: photo ? record ? `/api/listings/${d.id}/cover` : `/api/drafts/${d.id}/photos/${photo.id}` : undefined,
      url: receipt?.url,
      canDelete: !record?.deleteRequestedAt && !['relisting', 'replaced', 'deleted_by_owner'].includes(record?.status || '') && (status === 'queued' || (!!record?.receipt && status !== 'publishing')),
    };
  });
}
