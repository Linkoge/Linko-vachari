import type { Workflow } from './workflow';
import type { PublishQueue } from './queue';
import type { Draft } from './types';
import type { ListingRecord } from './listings';
import { redact } from './browser';

export interface ListingSummary {
  id: string; title: string; price: string; currency: string; account: string;
  status: 'queued' | 'preparing' | 'publishing' | 'live' | 'failed' | 'needs_input' | 'deleted-by-me' | 'relisted';
  progress?: string; reason?: string; draftId?: string;
  cover?: string; url?: string; canDelete: boolean;
}

/** One row per listing, including retries, older receipts and replacement history. */
export function myListings(flow: Workflow, queue: PublishQueue): ListingSummary[] {
  const drafts = new Map<string, Draft>();
  // Publish jobs, plus category/details jobs still in progress (a Publish pressed during one continues it).
  const jobs = new Map(queue.all().filter(j => j.operation === 'submit' || ['queued', 'running'].includes(j.status)).map(j => [j.draft, j]));
  for (const d of flow.store.all()) if (jobs.has(d.id) || ['published', 'unknown', 'publishing', 'needs_input'].includes(d.state)) drafts.set(d.id, d);
  const records = new Map<string, ListingRecord>();
  for (const r of flow.archive.all()) { records.set(r.id, r); if (!drafts.has(r.id)) drafts.set(r.id, r.recipe); }
  return [...drafts.values()].map(d => {
    const record = records.get(d.id), job = jobs.get(d.id), recipe = record?.recipe || d;
    const receipt = record?.receipt || d.receipt;
    let status: ListingSummary['status'] = 'failed';
    if (record?.status === 'deleted_by_owner') status = 'deleted-by-me';
    else if (!record?.deleteRequestedAt && !receipt && d.state === 'needs_input') status = 'needs_input';
    else if (record?.deleteRequestedAt || ['attention', 'missing', 'unavailable'].includes(record?.status || '')) status = 'failed';
    else if (record?.status === 'replaced') status = 'relisted';
    else if (record?.status === 'relisting' || ((job?.operation === 'submit' || queue.publishAfter(d.id)) && job?.status === 'running') || d.state === 'publishing') status = 'publishing';
    else if (job?.status === 'queued' && job.operation === 'submit') status = 'queued';
    else if (job && ['queued', 'running'].includes(job.status)) status = 'preparing';
    else if (receipt) status = 'live';
    else if (d.state === 'needs_input' || job?.status === 'needs_input') status = 'needs_input';
    const reason = status === 'needs_input'
      ? flow.openQuestions(d).length ? 'Required: ' + flow.openQuestions(d).map(q => q.label).join(', ') : d.message || 'Choose a category to continue.'
      : status === 'failed' ? record?.message || d.message || 'Publication could not be completed.' : undefined;
    const photo = recipe.photos.find(p => p.id === recipe.coverId) || recipe.photos[0];
    return { id: d.id, title: recipe.title || 'Untitled', price: recipe.price, currency: recipe.currency,
      account: flow.accounts.label(recipe.accountId || 'legacy'), status,
      progress: ['publishing', 'preparing'].includes(status) ? redact(d.step || d.message || 'Working…').slice(0, 160) : status === 'queued' ? 'Waiting to publish…' : undefined,
      reason: reason ? redact(reason).slice(0, 240) : undefined,
      draftId: status === 'needs_input' || (status === 'failed' && !record && !['unknown', 'publishing', 'published'].includes(d.state)) ? d.id : undefined,
      cover: photo ? record ? `/api/listings/${d.id}/cover` : `/api/drafts/${d.id}/photos/${photo.id}` : undefined,
      url: receipt?.url,
      canDelete: !record?.deleteRequestedAt && !['relisting', 'replaced', 'deleted_by_owner'].includes(record?.status || '') && (status === 'queued' || (!!record?.receipt && status !== 'publishing')),
    };
  });
}
