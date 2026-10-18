import { ElementInfo } from './browser';
import { Draft, WorkflowError } from './types';
export const publishLabel = /^(publish(?: listing| item)?|list item|გამოქვეყნება|განცხადების გამოქვეყნება|გამოაქვეყნე|გამოქვეყნება უფასოდ)$/i;
export const dangerousLabel = /publish|payment|pay now|buy|delete|remove account|checkout|log.?out|sign.?out|settings|password|save|terms|გამოქვეყნ|გამოაქვეყნ|გადახდა|შეძენა|წაშლა|გასვლა|შენახვა|პირობები|vip|boost|promot/i;
export const navigationLabel = /search|next|continue|back|add (?:listing|item|product)|sell|category|choose|select|ძებნ|ძიება|შემდეგ|გაგრძელ|უკან|დამატება|გაყიდ|კატეგორ|აირჩი|არჩევ/i;
export function sourceValue(d: Draft, source: string, query: string) {
  if (source === 'query') return query;
  if (source === 'category') return d.category.join(' > ');
  if (source.startsWith('fields.')) return d.fields.find(f => f.label === source.slice(7))?.value || '';
  if (source.startsWith('facts.')) return d.facts[source.slice(6)] || '';
  if (['title', 'description', 'price', 'currency', 'model', 'condition', 'location'].includes(source)) return String(d[source as keyof Draft] || '');
  return '';
}
export function guardClick(e: ElementInfo, phase: 'search' | 'prepare', category: string[], facts: string[]) {
  if (dangerousLabel.test(e.label) || e.type === 'password' || /login|sign in|შესვლა|ავტორიზაცია/i.test(e.label)) throw new WorkflowError('POLICY', 'This step needs manual login or a publishing decision. Open the local login browser to continue.');
  if (e.tag === 'a' && e.href && phase === 'search' && /^\/(?:en\/|ka\/|ru\/)?(?:pr\/|product\/|products\/|search\/)/.test(new URL(e.href).pathname)) return;
  const exactOption = [...category, ...facts].filter(Boolean).some(v => v.trim().toLocaleLowerCase() === e.label.trim().toLocaleLowerCase());
  if (!navigationLabel.test(e.label) && !exactOption && !['combobox', 'tab'].includes(e.role) && !['select', 'input'].includes(e.tag)) throw new WorkflowError('POLICY', 'An unfamiliar marketplace control needs inspection. The app stopped before taking an uncertain action.');
}
