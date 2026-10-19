import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ElementInfo, Snapshot } from './browser';
import { rawFieldLabel, type SpecField } from './types';
export { rawFieldLabel } from './types';
import { accountField } from './required-info';

// These are listing/account/transaction facts, never product-specification guesses.
export const ownerDetail = /condition|defect|damage|accessor|includ|warranty|price|currency|location|city|country|address|phone|mobile|contact|delivery|payment|promotion|vip|boost|მდგომარეობ|დეფექტ|დაზიან|კომპლექტ|მოყვება|აქსესუარ|გარანტ|ფასი|ვალუტ|მდებარეობ|ქალაქ|ქვეყან|მისამართ|ტელეფონ|მობილურ|მიტანა|გადახდა|состояни|дефект|поврежд|комплект|аксессуар|гарант|цен[аы]|город|телефон/i;
export const specSchemaVersion = 2;
const nonSpecControl = /^(?:title(?:[_-]\d+)?|description|price|currency|user|account|phone|mobile|location|city|address|videourl|video_url|\d+)$/i;
export function matchingControls(field: SpecField, snapshot: Snapshot): ElementInfo[] {
  const controls = snapshot.elements.filter(e => ['input', 'select', 'textarea'].includes(e.tag) || e.role === 'combobox');
  const stable = field.controlId ? controls.filter(e => e.controlId === field.controlId) : [];
  return stable.length ? stable : controls.filter(e => (e.group || e.label) === field.label);
}
const coreField = /(?:^|\s)(title|listing title|description|item description|price|asking price|currency|category|category path|სათაური|დასახელება|აღწერა|ფასი|ვალუტა|კატეგორია|название|описание|цена|валюта|категория)(?:\s|\*|$)/i;
const transactional = /promotion|vip|boost|delivery|payment|terms|agreement|მიტანა|გადახდა|პირობ|რეკლამ|დაწინაურ/i;
export const specKey = (label: string) => label.length <= 100 ? label : label.slice(0, 88) + createHash('sha256').update(label).digest('hex').slice(0, 12);
export function snapshotFields(snapshot: Snapshot): SpecField[] {
  const fields: SpecField[] = [];
  for (const e of snapshot.elements) {
    if (e.disabled || (!['input', 'select', 'textarea'].includes(e.tag) && e.role !== 'combobox') || ['file','hidden','password','submit','button','search','email'].includes(e.type)) continue;
    const label = (e.group || e.label).trim();
    if (!label || rawFieldLabel.test(label) || nonSpecControl.test((e.controlId || '').replace(/^(name|id):/, '')) || /video.?url|ვიდეო|видео/i.test(label) || coreField.test(label) || accountField({ key: '', label }) || transactional.test(label)) continue;
    if (e.type === 'checkbox' && !e.required) continue;
    const options = e.type === 'radio' ? snapshot.elements.filter(r => r.type === 'radio' && r.group === e.group).map(r => r.label) : e.options;
    if (fields.some(f => f.label === label)) continue;
    fields.push({ ...(e.controlId ? { controlId: e.controlId } : {}), ...(e.type === 'number' ? { inputType: 'number' as const } : {}), key: specKey(label), label, required: e.required || snapshot.elements.some(r => r.group === label && r.required), options: [...new Set(options.filter(o => o.trim() && !/^(choose|select|აირჩიე|არჩევა|выберите)[\s….*]*$/i.test(o)))], kind: ownerDetail.test(label) ? 'owner' : 'spec' });
  }
  return fields.slice(0, 80);
}
const fieldSchema = z.object({ controlId: z.string().max(300).optional(), inputType: z.literal('number').optional(), key: z.string().max(100), label: z.string().max(220), required: z.boolean(), options: z.array(z.string()).max(1000), kind: z.enum(['spec','owner']) });
const cacheSchema = z.record(z.string(), z.object({ version: z.literal(specSchemaVersion), at: z.number(), fields: z.array(fieldSchema).max(80) }));
export class SpecCache {
  constructor(public file: string) {}
  key(category: string[]) { return JSON.stringify(category); }
  read() { try { return cacheSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); } catch { return {}; } }
  get(category: string[]) { return this.read()[this.key(category)]?.fields; }
  set(category: string[], fields: SpecField[]) {
    const data = this.read(); data[this.key(category)] = { version: specSchemaVersion, at: Date.now(), fields };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify(data), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file);
  }
}
