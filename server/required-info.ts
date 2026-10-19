import type { Question } from './types';

export const defaultCity = 'თბილისი';
export const phoneLabel = /phone|mobile|\btel(?:ephone)?\b|მობილურ|ტელეფონ|телефон|мобильн/i;
const locationLabel = /location|city|ქალაქ|მდებარეობ|город/i;
/** Labels as the owner sees them: no required marker, element-id suffix, punctuation or irregular spacing. */
export const plainLabel = (text: string) => text.normalize('NFKC').replace(/\(\s*e\d+\s*\)/gi, ' ').replace(/[*:?]/g, ' ').replace(/\s+/g, ' ').trim();
export function accountField(q: Pick<Question, 'key' | 'label'>): 'location' | 'phone' | undefined {
  const label = plainLabel(q.key + ' ' + q.label);
  if (phoneLabel.test(label)) return 'phone';
  if (locationLabel.test(label)) return 'location';
}
/** Classify a live control by its label, group, stable name/id or telephone input type, however it was discovered. */
export function controlField(e: { label: string; group?: string; controlId?: string; type?: string }) {
  return accountField({ key: e.group || '', label: e.label })
    || accountField({ key: '', label: (e.controlId || '').replace(/^(?:name|id):/, '').replace(/[_.[\]-]+/g, ' ') })
    || (e.type === 'tel' ? 'phone' as const : undefined);
}
/** Contact answers stay on the server and never enter AI prompts or published recipes. */
export function itemFacts(facts: Record<string, string>, questions: Question[] = []) {
  return Object.fromEntries(Object.entries(facts).filter(([key]) => accountField(questions.find(q => q.key === key) || { key, label: key }) !== 'phone'));
}
/** A phone field that holds only a country-code prefix still needs the number. */
export const phoneFilled = (e: { hasValue: boolean; digits?: number }) => e.hasValue && (e.digits === undefined || e.digits >= 7);
