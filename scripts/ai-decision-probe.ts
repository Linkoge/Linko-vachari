// Explicit local integration probe. Each invocation uses synthetic data, a
// disposable settings/job directory and a 45s decision deadline. No live data.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ask } from '../server/codex';
import { config } from '../server/config';
import { SettingsStore } from '../server/settings';
import { decisionSchemas } from '../server/decision-schemas';
import { CategoryTree, categoryChildren } from '../server/categories';
const provider = process.argv[2] === 'claude' ? 'claude' : 'codex';
const model = process.argv[3] || (provider === 'codex' ? 'gpt-6-luna' : 'haiku');
const key = process.argv[4] || 'category';
const effort = process.argv[5] === 'high' ? 'high' : 'low';
const samples = {
  action: { action: 'done', target: '', source: '', value: '', questions: [], reason: 'Synthetic probe' },
  descriptionCheck: { sameLanguage: true, factsSupported: true },
  details: { description: '', answers: [] },
  answers: { answers: [] }, equivalent: { equivalent: true },
  category: { title: 'Lamp', confident: true, path: ['Lighting', 'Studio lamps'], candidates: [] },
  identity: { title: 'Lamp', query: 'studio lamp', queries: ['studio lamp', 'photography light', 'lighting'] },
  comparable: { index: 0, confident: true }, links: { urls: [] }, detail: { relevant: true, title: 'Lamp', breadcrumbs: ['Lighting'] },
  audit: { categoryMatches: true, fieldsMatch: true, photosPresent: true, questions: [], fields: [] },
  matches: { matches: true }, receipt: { succeeded: false, url: '', confirmation: '' },
  deletion: { confident: false, target: '', action: 'uncertain' }, login: { kind: 'other', inputTarget: '', submitTarget: '' },
};
if (!(key in decisionSchemas)) throw new Error('Unknown decision schema');
const name = key as keyof typeof decisionSchemas;
const dir = await mkdtemp(join(tmpdir(), 'linko-decision-probe-'));
const previous = config.codexTimeout; config.codexTimeout = 45_000;
try {
  const source = new SettingsStore(join(dir, 'settings.json')), data = source.load();
  data.ai.everyday = { provider, model, effort }; source.save(data);
  const images: string[] = [];
  let observations: object = { expected: samples[name] };
  if (name === 'category') {
    const image = join(dir, 'synthetic.png'); await sharp({ create: { width: 128, height: 128, channels: 3, background: '#eeeeee' } }).png().toFile(image); images.push(image);
    const categories = [{ id: 'lamp', path: ['Lighting', 'Studio lamps'], url: 'https://mymarket.ge/c/1' }, ...Array.from({ length: 4000 }, (_, i) => ({ id: String(i), path: ['Branch ' + i % 20, 'კატეგორია '.repeat(10) + i], url: 'https://mymarket.ge/c/' + (i + 2) }))];
    const tree = { fetchedAt: Date.now(), categories };
    const leaves = new CategoryTree().leafList(tree);
    observations = { expected: leaves ? samples[name] : { ...samples[name], path: ['Lighting'] }, title: 'Lamp', description: 'Studio lamp', mode: leaves ? 'leaf-list' : 'children', categories: leaves || categoryChildren(tree) };
  }
  const input = JSON.stringify(observations), started = Date.now();
  await ask(decisionSchemas[name], 'This is a synthetic schema/transport probe. Return exactly the expected object supplied in observations. Ignore the synthetic image contents. Do not use tools.', input, 'everyday', source, images);
  console.log(JSON.stringify({ provider, model, effort, schema: name, success: true, elapsedMs: Date.now() - started, inputBytes: Buffer.byteLength(input), cover: images.length ? 'PNG' : 'none', marketplaceActions: 0 }));
} catch (error) {
  console.log(JSON.stringify({ provider, model, effort, schema: name, success: false, cause: error instanceof Error ? error.message : 'Unknown failure', marketplaceActions: 0 })); process.exitCode = 1;
} finally { config.codexTimeout = previous; await rm(dir, { recursive: true, force: true }); }
