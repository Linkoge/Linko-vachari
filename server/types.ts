export type State = 'draft' | 'analyzing' | 'needs_input' | 'review' | 'preparing' | 'ready' | 'publishing' | 'published' | 'unknown' | 'blocked';
export interface Photo { id: string; width: number; height: number }
export interface Comparable { url: string; title: string; breadcrumbs: string[] }
export interface Question { key: string; label: string; options: string[] }
export interface FieldReview { label: string; value: string; source: string }
export interface Draft {
  accountId?: string; categoryMethod?: 'tree' | 'comparable-search' | 'owner'; categoryCandidates?: string[][];
  id: string; revision: number; state: State; title: string; description: string;
  price: string; currency: string; model: string; condition: string; location: string;
  facts: Record<string, string>; photos: Photo[]; coverId: string;
  category: string[]; comparables: Comparable[]; questions: Question[];
  fields: FieldReview[]; message: string; events: { at: string; message: string }[];
  preparedRevision?: number; preparedAt?: string; receipt?: { url: string; at: string; evidence: string };
  relistOf?: string;
  automation?: import('./replay').RecipeAutomation;
}
export class WorkflowError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
