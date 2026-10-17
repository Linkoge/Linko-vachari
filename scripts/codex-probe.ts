import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ask, codexStatus } from '../server/codex';
const status = await codexStatus();
let receipt: object;
try {
  const decision = await ask(z.object({ target: z.enum(['e7']), action: z.enum(['search_enter']) }), 'Choose the supplied Search element for a search-only next step. This is a synthetic read-only integration probe. Do not use tools.', JSON.stringify({ page: { text: 'MyMarket Search', elements: [{ id: 'e7', label: 'Search', type: 'search' }] } }));
  receipt = { checkedAt: new Date().toISOString(), ...status, transport: 'official codex exec', auth: 'Codex-managed ChatGPT sign-in', structuredDecisionVerified: decision.target === 'e7' && decision.action === 'search_enter', photoInputs: 0, marketplaceActions: 0, tokensReadOrExported: false };
} catch (e) { receipt = { checkedAt: new Date().toISOString(), ...status, transport: 'official codex exec', structuredDecisionVerified: false, blocker: e instanceof Error ? e.message : 'Codex unavailable', marketplaceActions: 0, tokensReadOrExported: false }; }
await writeFile('docs/evidence/codex-live-probe.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
