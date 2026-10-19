import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingsStore } from '../server/settings';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';
import { CredentialVault } from '../server/credentials';
import { createApp } from '../server/app';
import { savePhoto } from '../server/photos';
import { applyCondition, conditionChoice, conditionOption } from '../server/condition';
import { fillDetails } from '../server/details';
import { decisionSchemas } from '../server/decision-schemas';
import type { Draft, SpecField } from '../server/types';

const field = (label: string, options: string[], extra: Partial<SpecField> = {}): SpecField => ({ key: label, label, required: true, options, kind: 'owner', ...extra });

test('New/Used maps onto the live condition option in Georgian, English and Russian, and never guesses among several Used grades', () => {
  assert.equal(conditionOption('new', ['ახალი', 'მეორადი']), 'ახალი'); assert.equal(conditionOption('used', ['ახალი', 'მეორადი']), 'მეორადი');
  assert.equal(conditionOption('new', ['Brand new', 'Used']), 'Brand new'); assert.equal(conditionOption('used', ['New', 'Used']), 'Used');
  assert.equal(conditionOption('used', ['Новый', 'Б/у']), 'Б/у'); assert.equal(conditionOption('new', ['Новый', 'Б/у']), 'Новый');
  assert.equal(conditionOption('used', ['New', 'Like new', 'Used']), 'Used', '"Like new" is not New');
  assert.equal(conditionOption('used', ['New', 'Used - good', 'Used - fair']), undefined);
  assert.equal(conditionOption('new', ['A', 'B']), undefined);
  assert.equal(conditionChoice('new'), 'new'); assert.equal(conditionChoice('Used'), 'used'); assert.equal(conditionChoice('Used, good condition'), undefined); assert.equal(conditionChoice(''), undefined);
});

test('the toggle fills whichever condition control the form has (select, radio group or free text) and leaves other fields alone', () => {
  const draft = (condition: string) => Object.assign(new Store(':memory:').create('legacy'), { condition }) as Draft;
  const forms: [string, SpecField[], Record<string, string>][] = [
    ['used', [field('მდგომარეობა', ['ახალი', 'მეორადი'])], { 'მდგომარეობა': 'მეორადი' }],
    ['new', [field('Condition', ['New', 'Used']), field('Defects', [])], { Condition: 'New' }],
    ['used', [field('Condition', [])], { Condition: 'Used' }],
    ['new', [field('მდგომარეობა', [])], { 'მდგომარეობა': 'ახალი' }],
    ['used', [field('Состояние', ['Новый', 'Б/у'])], { 'Состояние': 'Б/у' }],
  ];
  for (const [choice, fields, expected] of forms) {
    const d = draft(choice); assert.equal(applyCondition(d, fields), true); assert.deepEqual(d.facts, expected);
    assert.equal(d.detailSources?.[Object.keys(expected)[0]], 'owner');
  }
  const none = draft(''); assert.equal(applyCondition(none, [field('Condition', ['New', 'Used'])]), false); assert.deepEqual(none.facts, {});
});

test('detail filling takes condition from the toggle, never from lookup or estimates, and a later toggle change replaces it', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(join(tmpdir(), 'linko-cond-'));
  const flow = new Workflow(store, undefined, new CredentialVault(join(root, 'account.json'), false), new SettingsStore(join(root, 'settings.json')));
  try {
    const d = Object.assign(store.create('legacy'), { title: 'Roller skates', description: 'Fast skates', price: '40', category: ['Sport', 'Skates'], condition: 'used', estimateMissing: true });
    const fields = [field('Condition', ['New', 'Used']), field('Wheel diameter', ['64 mm', '72 mm'], { kind: 'spec' })];
    const seen: string[] = [];
    flow.brain = (async (schema: unknown, _i: string, input: string) => {
      if (schema === decisionSchemas.details) { seen.push(...JSON.parse(input).fields.map((f: SpecField) => f.key)); return { description: '', answers: [] }; }
      return { values: Object.fromEntries(JSON.parse(input).fields.map((f: SpecField) => [f.key, f.options[0]])) };
    }) as never;
    await fillDetails(flow, d, fields);
    assert.equal(d.facts.Condition, 'Used'); assert.deepEqual(seen, ['Wheel diameter'], 'condition is not looked up');
    assert.equal(d.facts['Wheel diameter'], '64 mm'); assert.equal(d.detailSources?.['Wheel diameter'], 'estimated'); assert.deepEqual(d.questions, []);
    d.condition = 'new'; applyCondition(d); assert.equal(d.facts.Condition, 'New');
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the choice is saved with the draft, switches the form value, and is remembered as the default for the next listing', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'linko-cond-api-')), settings = new SettingsStore(join(root, 'settings.json'));
  const store = new Store(join(root, 'workspace.sqlite'), join(root, 'listings'));
  const flow = new Workflow(store, undefined, new CredentialVault(join(root, 'account.json'), false), settings);
  const accountId = flow.accounts.add({ label: 'Studio', identifier: 'owner@x.io', password: randomUUID() });
  const instance = createApp(store, flow), server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`, headers = { 'Content-Type': 'application/json', 'X-Linko-Request': '1' };
  try {
    const photo = await savePhoto(readFileSync('public/icons/icon-192.png'));
    const create = async () => (await (await fetch(`${base}/drafts`, { method: 'POST', headers, body: '{}' })).json()) as Draft;
    const first = await create(); assert.equal(first.condition, '', 'no condition is assumed before the owner chooses');
    Object.assign(first, { photos: [photo], coverId: photo.id, category: ['Cameras'], specFields: [field('Condition', ['New', 'Used'])] }); store.save(first);
    const save = async (d: Draft, condition: string) => {
      const r = await fetch(`${base}/drafts/${d.id}`, { method: 'PATCH', headers, body: JSON.stringify({ accountId, revision: d.revision, title: 'Lamp', description: 'x', price: '5', currency: 'GEL', model: '', condition, location: 'თბილისი', category: ['Cameras'], facts: {}, coverId: photo.id }) });
      assert.equal(r.status, 200); return (await r.json()) as Draft;
    };
    let saved = await save(first, 'used'); assert.equal(saved.condition, 'used'); assert.equal(saved.facts.Condition, 'Used');
    assert.equal(store.get(first.id).condition, 'used');
    saved = await save(saved, 'new'); assert.equal(saved.facts.Condition, 'New');
    assert.equal((await create()).condition, 'new', 'the last choice is the default for the next listing');
    saved = await save(saved, 'used'); assert.equal((await create()).condition, 'used');
  } finally { await new Promise<void>(r => server.close(() => r())); store.db.close(); rmSync(root, { recursive: true, force: true }); }
});
