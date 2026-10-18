import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import sharp from 'sharp';
import { z } from 'zod';
import { ask, claudeResult } from '../server/codex';
import { config } from '../server/config';
import { SettingsStore } from '../server/settings';
import { AIFailure, classifyAIError, cliErrorDetail, redactAIDetail } from '../server/ai-errors';
import { decisionJSONSchema, decisionSchemas } from '../server/decision-schemas';
import { registerSecret, unregisterSecret } from '../server/secrets';
import { codexModels, providerModels, validateModelChanges } from '../server/ai-models';
import { CategoryTree } from '../server/categories';

const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', '$ref', '$defs', 'anyOf', 'allOf', 'description', 'title']);
function strictSchema(node: any) {
  for (const key of Object.keys(node)) assert.ok(allowed.has(key), `unsupported keyword ${key}`);
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false);
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    Object.values(node.properties).forEach(strictSchema);
  }
  if (node.items) strictSchema(node.items);
  for (const key of ['anyOf', 'allOf']) node[key]?.forEach(strictSchema);
  if (node.$defs) Object.values(node.$defs).forEach(strictSchema);
}
test('every production decision uses the registry and compiles into the shared strict schema subset', async () => {
  assert.equal(Object.keys(decisionSchemas).length, 13);
  for (const schema of Object.values(decisionSchemas)) strictSchema(decisionJSONSchema(schema));
  // Catch new inline decision schemas that would silently escape this suite.
  for (const file of ['workflow', 'agent', 'deletion']) {
    const text = await readFile(`server/${file}.ts`, 'utf8');
    const source = ts.createSourceFile(file + '.ts', text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['decide', 'brain'].includes(node.expression.name.text)) {
        const schema = node.arguments[0]?.getText(source);
        assert.match(schema, /^(?:schema|decisionSchema|decisionSchemas\.\w+)$/);
        if (schema.startsWith('decisionSchemas.')) assert.ok(schema.slice(16) in decisionSchemas);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // Wire compatibility must never remove the post-parse business constraints.
  assert.equal(decisionSchemas.identity.safeParse({ title: 'Lamp', query: 'lamp', queries: [] }).success, false);
  assert.equal(decisionSchemas.category.safeParse({ title: '', confident: false, path: [], candidates: [[], [], [], []] }).success, false);
});

test('CLI causes classify both providers and redact before applying the 200-character bound', () => {
  const cases = [
    ['ERROR: {"error":{"type":"usage_limit_reached","message":"Usage limit reached. Try again at 2026-10-19 08:00 UTC"}}', 'usage'],
    ["ERROR: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.", 'model'],
    ['error: unknown model selection', 'model'],
    ['ERROR: Unsupported reasoning effort for this model', 'model'],
    ['ERROR: Invalid schema for response_format: additionalProperties is required', 'schema'],
    ['ERROR: maxItems is an unsupported schema keyword', 'schema'],
    ['error: unable to decode image', 'image'],
    ['error: request timed out', 'timeout'],
  ];
  for (const [detail, kind] of cases) assert.equal(classifyAIError(new Error(), detail).kind, kind, detail);
  assert.deepEqual(claudeResult('{"type":"system"}\n{"type":"result","subtype":"success","structured_output":{"ok":true}}\n'), { ok: true });
  assert.throws(() => claudeResult('{"type":"system"}\n{"type":"assistant"}\n'), /no final result/);
  const usage = classifyAIError(new Error(), '', JSON.stringify({ is_error: true, subtype: 'error', result: 'Usage limit reached; resets at 08:00 UTC' }));
  const reset = classifyAIError(new Error(), 'ERROR: ' + JSON.stringify({ error: { type: 'usage_limit_reached', message: 'Try again later', resets_at: 1792396800 } }));
  assert.equal(reset.kind, 'usage'); assert.match(reset.detail, /Resets at 2026-/);
  assert.equal(usage.kind, 'usage'); assert.match(usage.detail, /08:00 UTC/);
  assert.equal(classifyAIError(new SyntaxError('supplied private text')).kind, 'parse');
  assert.equal(classifyAIError(new AIFailure('timeout')).kind, 'timeout');
  assert.equal(classifyAIError(new AIFailure('image')).kind, 'image');
  const marker = randomUUID(); registerSecret(marker);
  const previous = process.env.LINKO_TEST_API_KEY; process.env.LINKO_TEST_API_KEY = randomUUID();
  try {
    const assignments = [['api_key', process.env.LINKO_TEST_API_KEY], ['password', 'hide me']]
      .map(([name, value]) => [name, JSON.stringify(value)].join('=')).join(' ');
    const detail = redactAIDetail(`Error ${marker} ${assignments} Bearer ${randomUUID()} https://user:pass@example.test/a?token=private /home/private/file ${'x'.repeat(250)}`);
    assert.ok(detail.length <= 200); assert.ok(!detail.includes(marker)); assert.ok(!detail.includes(process.env.LINKO_TEST_API_KEY));
    assert.ok(!detail.includes('hide me')); assert.ok(!detail.includes('user:pass')); assert.ok(!detail.includes('/home/private'));
    assert.equal(cliErrorDetail(`user\n${marker}\nERROR: unknown model\ncodex\n${marker}`), 'unknown model');
    assert.equal(classifyAIError(new SyntaxError(marker)).detail, '');
  } finally { unregisterSecret(marker); if (previous === undefined) delete process.env.LINKO_TEST_API_KEY; else process.env.LINKO_TEST_API_KEY = previous; }
});

test('both transports surface bounded CLI failures, invalid results, timeouts and images and clean every job', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linko-errors-')), source = new SettingsStore(join(dir, 'settings.json'));
  const before = [config.codexBinary, config.claudeBinary, config.codexTimeout] as const;
  const binary = join(dir, 'cli.mjs'), marker = randomUUID(); registerSecret(marker);
  const write = async (body: string) => writeFile(binary, `#!/usr/bin/env node
import {writeFileSync,readFileSync} from 'node:fs';
const a=process.argv;
if(a.includes('login')){console.error('Logged in using ChatGPT');process.exit(0)}
if(a.includes('auth')){console.log(JSON.stringify({authMethod:'claude.ai'}));process.exit(0)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{${body}});
`, { mode: 0o700 });
  try {
    config.codexBinary = binary; config.claudeBinary = binary;
    for (const provider of ['codex', 'claude'] as const) {
      const data = source.load(); data.ai.everyday = { provider, model: provider === 'codex' ? 'gpt-6-luna' : 'haiku', effort: 'low' }; source.save(data);
      await write(`console.error('user prompt ${marker}');console.error('ERROR: Usage limit reached; resets at 08:00 UTC; token=${marker}');process.exit(1);`);
      await assert.rejects(ask(z.object({ ok: z.boolean() }), '', marker, 'everyday', source), (e: Error) => /usage limit reached.*08:00 UTC/.test(e.message) && !e.message.includes(marker) && e.message.length < 300);
      await write(`if(a.includes('--output-last-message'))writeFileSync(a[a.indexOf('--output-last-message')+1],'not JSON');else console.log('not JSON');`);
      await assert.rejects(ask(z.object({ ok: z.boolean() }), '', '', 'everyday', source), /non-JSON output or parse failure/);
      await write(`if(a.includes('--output-last-message'))writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({ok:'wrong'}));else console.log(JSON.stringify({subtype:'success',structured_output:{ok:'wrong'}}));`);
      await assert.rejects(ask(z.object({ ok: z.boolean() }), '', '', 'everyday', source), /invalid output schema/);
      await write(`setInterval(()=>{},1000);`); config.codexTimeout = 100;
      await assert.rejects(ask(z.object({ ok: z.boolean() }), '', '', 'everyday', source), /decision timed out/); config.codexTimeout = before[2];
      await assert.rejects(ask(z.object({ ok: z.boolean() }), '', '', 'everyday', source, [join(dir, 'missing.png')]), /cover image problem/);
      // Probe each actual format even when the source filename lies about it.
      for (const format of ['jpeg', 'png', 'webp'] as const) {
        const image = join(dir, 'cover.bin'); await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } }).toFormat(format).toFile(image);
        await write(`let good=false;
if(a.includes('--image')){const file=a[a.indexOf('--image')+1];const b=readFileSync(file);good=file.endsWith('.${format === 'jpeg' ? 'jpg' : format}')&&b.length>10;writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({ok:good}));}
else{if(a[a.indexOf('--output-format')+1]!=='stream-json'||!a.includes('--verbose'))process.exit(5);const image=JSON.parse(input).message.content.find(v=>v.type==='image');good=image.source.media_type==='image/${format}'&&Buffer.from(image.source.data,'base64').length>10;console.log(JSON.stringify({type:'system',subtype:'init'}));console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{ok:good}}));}`);
        assert.deepEqual(await ask(z.object({ ok: z.boolean() }), '', '', 'everyday', source, [image]), { ok: true });
      }
      assert.equal((await readdir(dir)).some(p => p.startsWith('ai-job-')), false);
    }
    // Claude can return an error envelope with a successful process exit.
    await write(`console.log(JSON.stringify({is_error:true,subtype:'error_during_execution',result:'Unknown model for this account'}));`);
    await assert.rejects(ask(z.object({ ok: z.boolean() }), '', '', 'everyday', source), /unknown or unavailable model/);
  } finally { [config.codexBinary, config.claudeBinary, config.codexTimeout] = before; unregisterSecret(marker); await rm(dir, { recursive: true, force: true }); }
});

test('model catalog uses installed CLI metadata, filters hidden models/efforts and rejects unavailable choices', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linko-models-')), binary = join(dir, 'models.mjs'), previous = [config.codexBinary, config.claudeBinary];
  await writeFile(binary, `#!/usr/bin/env node
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{data:[{model:'visible',displayName:'Visible',supportedReasoningEfforts:[{reasoningEffort:'low'}]},{model:'hidden',hidden:true,supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}}))});`, { mode: 0o700 });
  try {
    config.codexBinary = binary; config.claudeBinary = join(dir, 'not-installed');
    assert.deepEqual((await providerModels()).claude, []);
    assert.deepEqual(await codexModels(), [{ name: 'Visible', model: 'visible', efforts: ['low'] }]);
    const ai = new SettingsStore(join(dir, 'settings.json')).load().ai;
    await validateModelChanges(ai, { ...ai, everyday: { provider: 'codex', model: 'visible', effort: 'low' } });
    await assert.rejects(validateModelChanges(ai, { ...ai, everyday: { provider: 'codex', model: 'visible', effort: 'high' } }), /unavailable/);
    await assert.rejects(validateModelChanges(ai, { ...ai, everyday: { provider: 'codex', model: 'invented', effort: 'low' } }), /unavailable/);
    const source = new SettingsStore(join(dir, 'old.json'));
    await writeFile(source.file, JSON.stringify({ ...source.load(), ai: { everyday: { provider: 'codex', model: 'gpt-5.4-mini', effort: 'low' }, fixit: { provider: 'codex', model: 'gpt-5.4', effort: 'high' } } }));
    assert.equal(source.load().ai.everyday.model, 'gpt-6-luna'); assert.equal(source.load().ai.fixit.model, 'gpt-6.1-sol');
    assert.match(await readFile(source.file, 'utf8'), /gpt-5.4-mini/); // migration does not write live settings
  } finally { [config.codexBinary, config.claudeBinary] = previous; await rm(dir, { recursive: true, force: true }); }
});

test('category prompts stay bounded with multilingual/no-overlap trees and sample every root', () => {
  const categories = Array.from({ length: 4000 }, (_, i) => ({ id: String(i), path: ['Branch ' + i % 20, 'კატეგორია '.repeat(10) + i], url: 'https://mymarket.ge/c/' + i }));
  const tree = new CategoryTree();
  for (const text of ['no overlap words', 'კატეგორია']) {
    const result = tree.shortlist({ fetchedAt: Date.now(), categories }, text);
    assert.ok(result.length <= 160); assert.ok(Buffer.byteLength(JSON.stringify(result.map(c => c.path))) <= 24_000);
  }
  assert.equal(new Set(tree.shortlist({ fetchedAt: Date.now(), categories }, 'no overlap words').map(c => c.path[0])).size, 20);
});
