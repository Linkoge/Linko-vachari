import type { ElementInfo, Snapshot } from './browser';
import type { Draft } from './types';
import { WorkflowError } from './types';
export type SemanticTarget = Pick<ElementInfo, 'tag' | 'role' | 'type' | 'label' | 'group'>;
export interface SavedStep { action: 'click' | 'fill' | 'select' | 'upload' | 'wait'; target: SemanticTarget; source: string; value: string }
export interface RecipeAutomation { steps: SavedStep[]; controls?: ReturnType<typeof controls>; images?: string[]; text?: string; confirmation?: string }
export class ScriptChanged extends WorkflowError { constructor(message = 'The marketplace page changed; the saved semantic step no longer matches.') { super('SCRIPT_CHANGED', message); } }
export const privateControl = (e: ElementInfo) => e.type === 'password' || /phone|mobile|email|password|მობილურ|ტელეფონ|ელ.?ფოსტ|პაროლ/i.test(e.label + (e.group || ''));
export function signature(e: ElementInfo): SemanticTarget { return { tag: e.tag, role: e.role, type: e.type, label: e.label, group: e.group || '' }; }
export function matches(e: ElementInfo, t: SemanticTarget) { return e.tag === t.tag && e.role === t.role && e.type === t.type && e.label === t.label && (e.group || '') === (t.group || ''); }
export function resolveStep(snapshot: Snapshot, step: SavedStep) {
  const found = snapshot.elements.filter(e => matches(e, step.target) && !e.disabled);
  if (found.length !== 1) throw new ScriptChanged();
  return found[0];
}
export function controls(s: Snapshot) {
  return s.elements.filter(e => (['input', 'textarea', 'select'].includes(e.tag) || e.role === 'combobox') && !['file', 'hidden', 'submit', 'button'].includes(e.type) && !privateControl(e)).map(e => ({ ...signature(e), value: e.value, checked: e.checked, options: e.options, required: e.required })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function auditRecipe(d: Draft, s: Snapshot) {
  const saved = d.automation;
  if (!saved?.controls?.length || !saved.images?.length || saved.text !== s.text || JSON.stringify(controls(s)) !== JSON.stringify(saved.controls) || JSON.stringify(s.images.map(i => i.alt)) !== JSON.stringify(saved.images)) throw new ScriptChanged('The saved recipe no longer matches the form fields or ordered photos.');
  if (s.elements.some(e => e.required && !e.hasValue && !['file', 'hidden'].includes(e.type))) throw new ScriptChanged('A required field is missing.');
}
