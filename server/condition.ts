import type { Draft, SpecField } from './types';

export type Condition = 'new' | 'used';
const isNew = /^(?:brand[\s-]*)?new(?![\w-])|^ახალი|^нов(?:ый|ое|ая|ые)?(?![\wа-я])/i;
const isUsed = /(?:^|\b)(?:used|pre[\s-]*owned|second[\s-]*hand)(?![\w])|^მეორადი|^ნახმარი|^б\s*\/?\s*у(?![\wа-я])|^бу(?![\wа-я])|^с\s+пробегом/i;
/** Fields that ask for the item's condition on a live form, in any of the marketplace's languages. */
export const conditionLabel = /condition|მდგომარეობ|состояни/i;
const defectLabel = /defect|damage|დეფექტ|დაზიან|дефект|поврежд/i;
const optionChoice = (text: string): Condition | undefined => isNew.test(text.trim()) ? 'new' : isUsed.test(text.trim()) ? 'used' : undefined;
/** The draft stores exactly the toggle's two values; older free-text conditions are not interpreted. */
export function conditionChoice(value: string | undefined): Condition | undefined {
  const text = (value || '').trim().toLocaleLowerCase();
  return text === 'new' || text === 'ახალი' ? 'new' : text === 'used' || text === 'მეორადი' ? 'used' : undefined;
}
/** The live option standing for New/Used, only when exactly one option does (never a guess among Used grades). */
export function conditionOption(choice: Condition, options: string[]) {
  const matches = options.filter(o => optionChoice(o) === choice);
  return matches.length === 1 ? matches[0] : undefined;
}
/** Map the New/Used toggle onto whatever condition control the live form has: a select, a radio group or free text. */
export function applyCondition(d: Draft, fields: SpecField[] = d.specFields || []) {
  const choice = conditionChoice(d.condition);
  if (!choice) return false;
  let changed = false;
  for (const f of fields) {
    if (!conditionLabel.test(f.label) || defectLabel.test(f.label)) continue;
    const value = f.options.length ? conditionOption(choice, f.options) : /[Ⴀ-ჿ]/.test(f.label) ? (choice === 'new' ? 'ახალი' : 'მეორადი') : choice === 'new' ? 'New' : 'Used';
    if (!value || d.facts[f.key] === value) continue;
    d.facts[f.key] = value; (d.detailSources ||= {})[f.key] = 'owner'; changed = true;
  }
  return changed;
}
