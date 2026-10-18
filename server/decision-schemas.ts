import { z } from 'zod';
const question = z.object({ key: z.string(), label: z.string(), options: z.array(z.string()) });
// Every model decision lives here, so compatibility checks cover the complete set.
export const decisionSchemas = {
  action: z.object({ action: z.enum(['click', 'fill', 'select', 'search_enter', 'upload', 'wait', 'done', 'blocked', 'category_unavailable']), target: z.string(), source: z.string(), value: z.string(), questions: z.array(question), reason: z.string() }),
  answers: z.object({ answers: z.array(z.object({ key: z.string().max(100), value: z.string().max(500), evidence: z.string() })) }),
  equivalent: z.object({ equivalent: z.boolean() }),
  category: z.object({ title: z.string(), confident: z.boolean(), path: z.array(z.string()), candidates: z.array(z.array(z.string())).max(3) }),
  identity: z.object({ title: z.string(), query: z.string(), queries: z.array(z.string()).min(3).max(4) }),
  comparable: z.object({ index: z.number().int(), confident: z.boolean() }),
  links: z.object({ urls: z.array(z.string()).min(0).max(3) }),
  detail: z.object({ relevant: z.boolean(), title: z.string(), breadcrumbs: z.array(z.string()).min(0).max(8) }),
  audit: z.object({ categoryMatches: z.boolean(), fieldsMatch: z.boolean(), photosPresent: z.boolean(), questions: z.array(question), fields: z.array(z.object({ label: z.string(), value: z.string(), source: z.string() })) }),
  matches: z.object({ matches: z.boolean() }),
  receipt: z.object({ succeeded: z.boolean(), url: z.string(), confirmation: z.string() }),
  deletion: z.object({ confident: z.boolean(), target: z.string(), action: z.enum(['navigate', 'delete', 'confirm', 'uncertain']) }),
  login: z.object({ kind: z.enum(['code', 'rejected', 'waiting', 'other']), inputTarget: z.string(), submitTarget: z.string() }),
};
// Use the shared strict subset for both CLIs. Bounds remain enforced by Zod after
// parsing; removing them on the wire supports providers with smaller subsets.
export function decisionJSONSchema(schema: z.ZodType): Record<string, any> {
  const visit = (node: any): any => {
    const result: Record<string, any> = {};
    for (const key of ['type', 'enum', 'const', '$ref', 'description', 'title']) if (node[key] !== undefined) result[key] = node[key];
    for (const key of ['anyOf', 'allOf']) if (node[key]) result[key] = node[key].map(visit);
    if (node.$defs) result.$defs = Object.fromEntries(Object.entries(node.$defs).map(([k, v]) => [k, visit(v)]));
    if (node.properties) {
      result.type = 'object'; result.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, visit(v)]));
      result.required = Object.keys(node.properties); result.additionalProperties = false;
    }
    if (node.items) result.items = visit(node.items);
    return result;
  };
  return visit(z.toJSONSchema(schema, { target: 'draft-7' }));
}
