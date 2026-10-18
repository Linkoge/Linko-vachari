import type { Question } from './types';

export const defaultCity = 'თბილისი';
export const phoneLabel = /phone|mobile|მობილურ|ტელეფონ/i;
export function accountField(q: Pick<Question, 'key' | 'label'>): 'location' | 'phone' | undefined {
  const label = q.key + ' ' + q.label;
  if (phoneLabel.test(label)) return 'phone';
  if (/location|city|ქალაქ|მდებარეობ/i.test(label)) return 'location';
}
/** Contact answers stay on the server and never enter AI prompts or published recipes. */
export function itemFacts(facts: Record<string, string>, questions: Question[] = []) {
  return Object.fromEntries(Object.entries(facts).filter(([key]) => accountField(questions.find(q => q.key === key) || { key, label: key }) !== 'phone'));
}
