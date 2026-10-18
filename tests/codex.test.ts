import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { privateDir, config } from '../server/config';
import { ask, codexEnvironment, codexArgs } from '../server/codex';
test('supported Codex CLI transport validates structured outputs, withholds secret environment and removes transient results', async () => {
  const dir = await mkdtemp(join(privateDir, 'test-codex-')); const binary = join(dir, 'fixture.mjs'); const old = config.codexBinary;
  await writeFile(binary, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0)}\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{if(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY||process.env.MYMARKET_PASSWORD)process.exit(4);if(input.includes('data:image/'))process.exit(5);const p=process.argv[process.argv.indexOf('--output-last-message')+1];writeFileSync(p,JSON.stringify({target:'e7'}))});`, { mode: 0o700 });
  try { config.codexBinary = binary; assert.equal(codexEnvironment().OPENAI_API_KEY, undefined); assert.equal(codexEnvironment().CODEX_API_KEY, undefined); assert.equal(codexEnvironment().MYMARKET_PASSWORD, undefined);
    const args = codexArgs(dir); assert.ok(args.includes('--ephemeral')); assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('forced_login_method="chatgpt"'));
    assert.deepEqual(await ask(z.object({ target: z.enum(['e7']) }), 'Choose a Search control.', '{"label":"Search"}'), { target: 'e7' });
    await assert.rejects(ask(z.object({ target: z.enum(['e8']) }), 'Choose a Search control.', '{}'), /Codex could not/);
    await writeFile(binary, "#!/usr/bin/env node\nconsole.log('Not logged in');process.exit(1)\n", { mode: 0o700 });
    await assert.rejects(ask(z.object({ target: z.string() }), '', '{}'), /normal ChatGPT sign-in/);
    assert.equal((await readFile(binary, 'utf8')).includes('Not logged in'), true);
  } finally { config.codexBinary = old; await rm(dir, { recursive: true, force: true }); }
});

test('category cover is attached through both CLI transports without enabling tools or retaining image jobs', async () => {
  const { SettingsStore } = await import('../server/settings');
  const { savePhoto } = await import('../server/photos');
  const { readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(privateDir, 'test-cover-')), source = new SettingsStore(join(dir, 'settings.json'));
  const previous = [config.codexBinary, config.claudeBinary];
  const photo = await savePhoto(await readFile('public/icons/icon-192.png'));
  const cover = join(privateDir, 'photos', photo.id + '.jpg');
  try {
    for (const provider of ['codex', 'claude'] as const) {
      const binary = join(dir, provider + '.mjs');
      await writeFile(binary, `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const a=process.argv;
if(a.includes('login')){console.log('Logged in using ChatGPT');process.exit(0)}
if(a.includes('auth')){console.log(JSON.stringify({authMethod:'claude.ai',loggedIn:true}));process.exit(0)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
let bytes;
if(a.includes('--image')) {
 const file=a[a.indexOf('--image')+1]; if(!file.includes('ai-job-')||!a.includes('features.shell_tool=false'))process.exit(3);
 bytes=readFileSync(file); writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({attached:bytes[0]===255&&bytes[1]===216}));
} else {
 if(a[a.indexOf('--input-format')+1]!=='stream-json'||a[a.indexOf('--tools')+1]!=='')process.exit(4);
 const message=JSON.parse(input); const image=message.message.content.find(c=>c.type==='image'); bytes=Buffer.from(image.source.data,'base64');
 console.log(JSON.stringify({subtype:'success',structured_output:{attached:bytes[0]===255&&bytes[1]===216}}));
}
});`, { mode: 0o700 });
      config.codexBinary = binary; config.claudeBinary = binary;
      const settings = source.load(); settings.ai.everyday.provider = provider; source.save(settings);
      assert.deepEqual(await ask(z.object({ attached: z.boolean() }), 'Classify the cover.', '{}', 'everyday', source, [cover]), { attached: true });
      assert.equal((await readdir(dir)).some(name => name.startsWith('ai-job-')), false);
    }
  } finally { [config.codexBinary, config.claudeBinary] = previous; await rm(dir, { recursive: true, force: true }); await rm(cover, { force: true }); }
});
