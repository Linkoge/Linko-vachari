export type State = 'draft' | 'queued' | 'analyzing' | 'needs_input' | 'review' | 'preparing' | 'ready' | 'publishing' | 'published' | 'unknown' | 'blocked';
export interface Photo { id: string; width: number; height: number }
export interface Comparable { url: string; title: string; breadcrumbs: string[] }
export interface Question { key: string; label: string; options: string[] }
export interface SpecField extends Question { inputType?: 'number'; required: boolean; kind: 'spec' | 'owner' }
export type DetailSource = 'owner' | 'input' | 'lookup' | 'estimated';
export interface FieldReview { label: string; value: string; source: string }
export interface Draft {
  specCategory?: string[]; specFields?: SpecField[]; detailSources?: Record<string, DetailSource>; estimateMissing?: boolean;
  ownerDescription?: string; originalDescription?: string; descriptionRewritten?: boolean;
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
