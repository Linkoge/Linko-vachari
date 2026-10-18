import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Draft } from '../server/types';
import { mergePhotoAppend } from '../src/photo-uploads';

function draft(): Draft {
  return { id: 'draft', revision: 0, state: 'draft', title: '', description: '', price: '', currency: 'GEL', model: '', condition: '', location: '', category: [], facts: {}, photos: [], coverId: '', comparables: [], questions: [], fields: [], events: [], message: '' };
}
const a = { id: 'a', width: 192, height: 192 }, b = { id: 'b', width: 512, height: 512 }, c = { id: 'c', width: 192, height: 192 };

test('photo append reconciliation preserves unsaved fields, category, cover and gallery order', () => {
  const base = { ...draft(), photos: [a, b], coverId: a.id };
  const local = { ...base, title: 'Typed while uploading', description: 'Newest text', price: '25', category: ['Lighting'], facts: { Condition: 'Used' }, photos: [b, a], coverId: b.id };
  const remote = { ...base, revision: 1, photos: [a, b, c] };
  const merged = mergePhotoAppend(base, local, remote);
  assert.equal(merged.revision, 1); assert.equal(merged.title, local.title); assert.equal(merged.description, local.description); assert.equal(merged.price, local.price);
  assert.deepEqual(merged.category, local.category); assert.deepEqual(merged.facts, local.facts);
  assert.deepEqual(merged.photos, [b, a, c]); assert.equal(merged.coverId, b.id);
  assert.deepEqual(base.photos, [a, b]); assert.deepEqual(remote.photos, [a, b, c]);
});

test('first background photo supplies the cover while preserving typed text', () => {
  const base = draft(), local = { ...base, title: 'Lamp' }, remote = { ...base, revision: 1, photos: [a], coverId: a.id };
  const merged = mergePhotoAppend(base, local, remote);
  assert.equal(merged.coverId, a.id); assert.equal(merged.title, 'Lamp'); assert.deepEqual(merged.photos, [a]);
});

test('photo rebasing refuses conflicting text, facts, cover, reorder, removal and locked states', () => {
  const base = { ...draft(), photos: [a, b], coverId: a.id }, local = { ...base, title: 'Local edit' };
  for (const change of [
    { title: 'Other device' }, { description: 'Other description' }, { accountId: 'other' }, { category: ['Other'] }, { facts: { Condition: 'New' } },
    { photos: [b, a] }, { photos: [a] }, { coverId: b.id }, { state: 'queued' as const },
  ]) {
    assert.throws(() => mergePhotoAppend(base, local, { ...base, revision: 1, ...change }), /Reload the saved draft/);
  }
});
