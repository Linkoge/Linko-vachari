import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { SettingsStore } from '../server/settings';
import { decisionSchemas } from '../server/decision-schemas';
import type { Draft, SpecField } from '../server/types';
import type { ask } from '../server/codex';

// Three unrelated category forms: required fields, control types, labels and ids all differ.
// The code under test contains no category-specific logic, so one generic driver runs them all.
interface Case { name: string; title: string; path: string[]; condition: 'new' | 'used'; direct?: boolean; html: (title: string) => string; expected: Record<string, string>; steps?: boolean }
const cases: Case[] = [
  { name: 'camera', title: 'Nikon D3400', path: ['Electronics', 'Cameras'], condition: 'used', expected: { 'select[name=type]': 'DSLR', 'input[name=mp]': '24', 'select[name=cond]': 'მეორადი', 'select[name=city]': 'თბილისი', 'input[type=tel]': '@phone' },
    html: t => `<h2>${t}</h2><label>Camera type *<select name="type" required><option value="">Choose</option><option>DSLR</option><option>Mirrorless</option></select></label>
      <label>Megapixels<input type="number" name="mp"></label>
      <label>მდგომარეობა *<select name="cond" required><option value="">აირჩიე</option><option>ახალი</option><option>მეორადი</option></select></label>
      <label>ქალაქი/ზუსტი მდებარეობა *<select name="city" required><option value="">Choose</option><option>ბათუმი</option><option>თბილისი</option></select></label>
      <label>მობილურის ნომერი*<input type="tel" required></label><button>Publish listing</button>` },
  { name: 'roller skates', title: 'Inline roller skates', path: ['Sport', 'Skating', 'Roller skates'], condition: 'new', expected: { 'select[name=wheel]': '64 mm', 'select[name=cond]': 'New', 'input[name=city]': 'თბილისი', 'input[name=contact_phone]': '@phone', 'input[name="Attr-text-47"]': '' },
    html: t => `<h2>${t}</h2><label>Wheel diameter *<select name="wheel" required><option value="">Choose</option><option>64 mm</option><option>72 mm</option></select></label>
      <label>Attr-text-47<input name="Attr-text-47"></label>
      <label>Condition *<select name="cond" required><option value="">Choose</option><option>New</option><option>Used</option></select></label>
      <label>City *<input name="city" required></label>
      <input name="contact_phone" required><button>Publish listing</button>` },
  { name: 'clothing', title: 'Wool winter coat', path: ['Clothing', 'Women', 'Coats'], condition: 'used', direct: true, expected: { 'select[name=size]': 'S', 'input[name=material]': 'Generic value', 'input[name=cond]': 'მეორადი', 'input[name=tel]': '@phone', 'input[name=place]': 'თბილისი' },
    html: t => `<h2>${t}</h2><label>Size *<select name="size" required><option value="">Choose</option><option>S</option><option>M</option></select></label>
      <label>Material<input name="material"></label><label>მდგომარეობა<input name="cond"></label>
      <label>ტელეფონი *<input name="tel" required></label><label>მდებარეობა *<input name="place" required></label><button>Publish listing</button>` },
];

for (const c of cases) test(`${c.name}: Find category reads and fills every field in one pass, and Publish completes whatever is missing`, { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'linko-forms-')), browser = await chromium.launch(), page = await browser.newPage();
  const store = new Store(join(root, 'workspace.sqlite'), join(root, 'listings')), settings = new SettingsStore(join(root, 'settings.json'));
  const flow = new Workflow(store, undefined, new CredentialVault(join(root, 'account.json'), false), settings);
  const phone = '5' + randomInt(10_000_000, 99_999_999), prompts: string[] = [], steps: string[] = [];
  try {
    flow.accounts.add({ label: 'Main', identifier: 'owner@x.io', password: randomUUID() });
    flow.accounts.saveDefaults('legacy', { location: 'თბილისი', phone });
    const data = settings.load(); data.automation.publish = true; settings.save(data);
    flow.browser.page = page; flow.useAccount = async () => {}; flow.accounts.use = () => {};
    flow.auth.ensureSignedIn = async () => { await page.setContent(c.html(c.title)); return true; };
    const tree = { fetchedAt: Date.now(), categories: cases.map((o, i) => ({ id: String(i + 1), path: o.path, url: 'https://mymarket.ge/c/' + (i + 1) })) };
    flow.categories.fresh = (async () => tree) as never;
    flow.brain = (async (schema: unknown, _instructions: string, input: string) => {
      prompts.push(input);
      if (schema === decisionSchemas.category) return { title: c.title, confident: true, path: c.path, candidates: [] };
      if (schema === decisionSchemas.details) {
        const fields: SpecField[] = JSON.parse(input).fields;
        return { description: '', answers: fields.filter(f => f.kind === 'spec').map(f => ({ key: f.key, value: f.options[0] ?? (f.inputType === 'number' ? '24' : 'Generic value'), source: 'lookup', evidence: 'specification', url: 'https://spec.example/item' })) };
      }
      if (schema === decisionSchemas.equivalent) return { equivalent: true };
      if (schema === decisionSchemas.audit) return { categoryMatches: true, fieldsMatch: true, photosPresent: true, questions: [], fields: [{ label: 'Title', value: c.title, source: 'title' }] };
      return { action: 'done', target: '', source: '', value: '', questions: [], reason: '' };
    }) as typeof ask;
    const agent = flow.agent.bind(flow); flow.agent = async (...args) => { const result = await agent(...args); return result && { ...result, uploaded: true }; };
    const save = store.save.bind(store); store.save = (d: Draft) => { if (d.step && steps.at(-1) !== d.step) steps.push(d.step); save(d); };
    let published = 0; flow.publish = async d => { published++; d.state = 'published'; };
    const d = Object.assign(store.create('legacy'), { title: c.title, description: 'Owner description', price: '120', condition: c.condition });
    store.save(d);

    if (!c.direct) {
      // Find category: category AND fields AND their values, in one continuous job.
      await flow.run(d.id, 'analyze');
      const found = store.get(d.id);
      assert.deepEqual(found.category, c.path); assert.ok(found.specFields?.length, 'fields were read'); assert.equal(published, 0);
      assert.ok(found.specFields!.every(f => !/^Attr-/.test(f.label)), 'raw ids are not shown as fields');
      for (const f of found.specFields!.filter(f => f.required && f.kind === 'spec')) assert.ok(found.facts[f.key], `${f.label} was filled`);
      assert.deepEqual(found.questions, []); assert.equal(found.step, undefined);
      assert.ok(steps.includes('Finding category…') && steps.includes('Reading fields…') && steps.includes('Looking up specs…'), steps.join(' | '));
    }
    // Publish at any time runs whatever is still missing (the whole thing, when nothing was done before).
    await flow.run(d.id, 'submit');
    const done = store.get(d.id);
    assert.equal(done.state, 'published', done.message); assert.equal(published, 1); assert.deepEqual(done.questions, []);
    assert.deepEqual(done.category, c.path); assert.ok(steps.includes('Filling form…'), steps.join(' | '));
    for (const [selector, expected] of Object.entries(c.expected)) assert.equal(await page.locator(selector).inputValue(), expected === '@phone' ? phone : expected, selector);
    assert.equal(prompts.some(p => p.includes(phone)), false, 'the saved phone never reaches a model');
    assert.equal(JSON.stringify(done).includes(phone), false);
  } finally { await browser.close(); store.db.close(); rmSync(root, { recursive: true, force: true }); }
});
