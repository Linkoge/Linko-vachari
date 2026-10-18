import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { SettingsStore } from '../server/settings';
import { ask, providerStatus, claudeArgs } from '../server/codex';
import { config } from '../server/config';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import { Workflow } from '../server/workflow';

test('both slots persist and dispatch exactly the selected provider/model/effort, with no fallback', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'linko-ai-')), source = new SettingsStore(join(root, 'settings.json'));
  const before = [config.codexBinary, config.claudeBinary, config.codexTimeout];
  const codex = join(root, 'codex.mjs'), claude = join(root, 'claude.mjs'), calls = join(root, 'calls.json');
  const code = (provider: string) => `#!/usr/bin/env node
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('login')){console.error('Logged in using ChatGPT');process.exit(0)}
if(args.includes('auth')){console.log(JSON.stringify({authMethod:'claude.ai'}));process.exit(0)}
if(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.MYMARKET_PASSWORD)process.exit(9);
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const path=${JSON.stringify(calls)};const calls=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];calls.push({provider:${JSON.stringify(provider)},args,input});writeFileSync(path,JSON.stringify(calls));
if(args.includes('--output-last-message'))writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({ok:true}));else console.log(JSON.stringify({subtype:'success',structured_output:{ok:true}}));
});`;
  writeFileSync(codex, code('codex'), { mode: 0o700 }); writeFileSync(claude, code('claude'), { mode: 0o700 });
  const marker = randomUUID(); const schema = z.object({ ok: z.boolean() });
  try {
    config.codexBinary = codex; config.claudeBinary = claude;
    const data = source.load(); data.telegram.token = marker;
    data.ai.everyday = { provider: 'claude', model: 'haiku', effort: 'low' }; data.ai.fixit = { provider: 'codex', model: 'chosen-model', effort: 'high' };
    source.save(data); const reloaded = new SettingsStore(source.file); assert.deepEqual(reloaded.load().ai, data.ai);
    assert.equal(statSync(source.file).mode & 0o777, 0o600); assert.equal(JSON.stringify(source.view()).includes(marker), false);
    assert.equal((await providerStatus('claude')).signedIn, true);
    await ask(schema, 'Decide', marker, 'everyday', reloaded); await ask(schema, 'Repair', '{}', 'fixit', reloaded);
    const dispatched = JSON.parse(readFileSync(calls, 'utf8')); assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].provider, 'claude'); assert.ok(dispatched[0].args.includes('haiku')); assert.ok(dispatched[0].args.includes('low'));
    assert.equal(dispatched[0].input.includes(marker), false); assert.ok(dispatched[0].args.includes('--tools')); assert.equal(dispatched[0].args[dispatched[0].args.indexOf('--tools')+1], '');
    assert.equal(dispatched[1].provider, 'codex'); assert.ok(dispatched[1].args.includes('chosen-model')); assert.ok(dispatched[1].args.includes('model_reasoning_effort="high"'));
    // The manager-style family buttons save an exact model ID, and effort taps
    // update that same record. The next decision must use the updated pair.
    data.ai.fixit = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }; source.save(data);
    await ask(schema, 'Repair again', '{}', 'fixit', reloaded);
    const selected = JSON.parse(readFileSync(calls, 'utf8'))[2];
    assert.equal(selected.provider, 'codex'); assert.ok(selected.args.includes('gpt-6.1-sol')); assert.ok(selected.args.includes('model_reasoning_effort="medium"'));
    config.claudeBinary = join(root, 'not-installed'); await assert.rejects(ask(schema, '', '', 'everyday', source), /Claude Code needs/);
    assert.equal(JSON.parse(readFileSync(calls, 'utf8')).length, 3);
    config.claudeBinary = claude;
    writeFileSync(claude, "#!/usr/bin/env node\nconsole.log(JSON.stringify({authMethod:'none'}));process.exit(1)", { mode: 0o700 });
    assert.equal((await providerStatus('claude')).signedIn, false); await assert.rejects(ask(schema,'','','everyday',source), /sign-in/);
    writeFileSync(claude, code('claude').replace("console.log(JSON.stringify({subtype:'success',structured_output:{ok:true}}))", "console.log(JSON.stringify({subtype:'success',structured_output:{ok:'invalid'}}))"), { mode: 0o700 });
    await assert.rejects(ask(schema,'','','everyday',source), /Claude Code could not/);
    writeFileSync(claude, "#!/usr/bin/env node\nif(process.argv.includes('auth')){console.log(JSON.stringify({authMethod:'claude.ai'}));process.exit(0)}setInterval(()=>{},1000);", { mode: 0o700 });
    config.codexTimeout = 150; const started = Date.now(); await assert.rejects(ask(schema,'','','everyday',source), /Claude Code could not/); assert.ok(Date.now()-started < 3000);
    assert.equal(readdirSync(root).some(p => p.startsWith('ai-job-')), false);
    assert.ok(claudeArgs(data.ai.everyday, {}).includes('--no-session-persistence'));
  } finally { [config.codexBinary, config.claudeBinary, config.codexTimeout] = before as [string,string,number]; rmSync(root, { recursive: true, force: true }); }
});

test('settings API saves only two slots and keeps Telegram token write-only behind CSRF', { timeout: 30_000 }, async () => {
  const previousClaude = config.claudeBinary; config.claudeBinary = new URL('./fixtures/codex-fixture.mjs', import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), 'linko-settings-')), source = new SettingsStore(join(root, 'settings.json'));
  const store = new Store(':memory:', join(root,'listings')), flow = new Workflow(store, ask, undefined, source);
  const { app } = createApp(store, flow), server = app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.on('listening',r));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/settings`, headers = {'Content-Type':'application/json','X-Linko-Request':'1'};
  const marker = randomUUID();
  try {
    const data = source.load(); data.ai.fixit = {provider:'claude',model:'opus',effort:'high'};
    assert.equal((await fetch(base+'/ai',{method:'PUT',headers,body:JSON.stringify(data.ai)})).status,200);
    assert.deepEqual(new SettingsStore(source.file).load().ai,data.ai);
    assert.equal((await fetch(base+'/ai',{method:'PUT',headers,body:JSON.stringify({...data.ai,third:data.ai.fixit})})).status,400);
    assert.equal((await fetch(base+'/telegram',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:marker,chatId:'123'})})).status,403);
    const response = await fetch(base+'/telegram',{method:'PUT',headers,body:JSON.stringify({token:marker,chatId:'123'})});
    const text = await response.text(); assert.equal(text.includes(marker),false); assert.equal(response.headers.get('cache-control'),'no-store'); assert.equal(source.load().telegram.token,marker);
    await fetch(base+'/telegram',{method:'PUT',headers,body:JSON.stringify({chatId:'456'})}); assert.equal(source.load().telegram.token,marker);
    flow.busy = true; assert.equal((await fetch(base+'/ai',{method:'PUT',headers,body:JSON.stringify(data.ai)})).status,409);
  } finally { config.claudeBinary = previousClaude; await new Promise<void>(r=>server.close(()=>r())); store.db.close(); rmSync(root,{recursive:true,force:true}); }
});
