import type { Draft } from '../server/types';

export class RequestError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

// Rebase only an append to the gallery. A text edit, removal, reorder or cover
// change from another device must still go through the existing conflict UI.
export function mergePhotoAppend(base: Draft, local: Draft, remote: Draft): Draft {
  const keys = ['accountId', 'title', 'description', 'price', 'currency', 'model', 'condition', 'location', 'category', 'facts'] as const;
  const originalIds = new Set(base.photos.map(p => p.id));
  if (['queued', 'analyzing', 'preparing', 'publishing', 'published', 'unknown'].includes(remote.state) ||
      keys.some(k => JSON.stringify(base[k]) !== JSON.stringify(remote[k])) ||
      JSON.stringify(base.photos) !== JSON.stringify(remote.photos.filter(p => originalIds.has(p.id))) ||
      (base.coverId ? remote.coverId !== base.coverId : remote.coverId !== (remote.photos[0]?.id || ''))) {
    throw new RequestError('This draft changed in another tab. Reload the saved draft before continuing.', 409, 'CONFLICT');
  }
  return { ...remote, ...Object.fromEntries(keys.map(k => [k, local[k]])),
    photos: [...local.photos, ...remote.photos.filter(p => !originalIds.has(p.id))],
    coverId: local.coverId || remote.coverId };
}

export function uploadPhoto(draftId: string, file: File, revision: number, progress: (value: number) => void): Promise<Draft> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/drafts/${draftId}/photos`);
    request.setRequestHeader('X-Linko-Request', '1');
    request.setRequestHeader('If-Match', String(revision));
    request.timeout = 120_000;
    request.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => {
      if (request.status === 401) window.dispatchEvent(new Event('linko-signed-out'));
      try {
        const data = JSON.parse(request.responseText);
        if (request.status >= 200 && request.status < 300) resolve(data);
        else reject(new RequestError(data.message || 'Photo upload failed. Please retry.', request.status, data.code));
      } catch (e) { reject(e); }
    };
    request.onerror = request.ontimeout = () => reject(new Error('Photo upload did not complete. Check your connection and retry.'));
    const form = new FormData(); form.append('photos', file);
    request.send(form);
  });
}
