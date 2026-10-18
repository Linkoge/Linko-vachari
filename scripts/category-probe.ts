import { writeFile, readFile } from 'node:fs/promises';
import { Store } from '../server/store';
import { ask } from '../server/codex';
import { Workflow } from '../server/workflow';
import { savePhoto } from '../server/photos';
// Category-only live verification. No form preparation, photo upload to MyMarket or submission.
let photoInputs = 0;
const store = new Store(':memory:'); const flow = new Workflow(store, ((schema, instructions, input, slot, settings, images = []) => { photoInputs += images.length; return ask(schema, instructions, input, slot, settings, images); }) as typeof ask);
const draft = store.create(); const photo = await savePhoto(await readFile('public/icons/icon-192.png'));
Object.assign(draft, { model: 'Canon EOS R50', description: 'Canon EOS R50 camera', price: '1', photos: [photo], coverId: photo.id }); store.save(draft);
try {
  await flow.run(draft.id, 'analyze'); const result = store.get(draft.id);
  const receipt = { checkedAt: new Date().toISOString(), kind: 'synthetic category-only live integration probe', backend: 'official Codex CLI with ChatGPT sign-in', state: result.state, message: result.message, category: result.category, comparableUrls: result.comparables.map(c => c.url), comparableCount: result.comparables.length, mainPhotoUnchanged: result.coverId === photo.id, categoryMethod: result.categoryMethod, coverInputsToAI: photoInputs, marketplacePhotoUploads: 0, marketplacePublications: 0, authenticatedListingIntegrationVerified: false };
  await writeFile('docs/evidence/codex-category-probe.json', JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} finally { await flow.browser.close(); store.db.close(); }
