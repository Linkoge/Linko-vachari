import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../server/settings';
import { Telegram } from '../server/telegram';
import { redact } from '../server/browser';

test('Telegram fake HTTP server: send/test/detect, redaction, errors, bounded hangs and non-blocking notifications', { timeout: 10_000 }, async t => {
  const logs: string[] = [];
  for (const method of ['log','warn','error'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args.join(' ')); });
  const root = mkdtempSync(join(tmpdir(),'linko-telegram-')), source = new SettingsStore(join(root,'settings.json'));
  const marker = randomUUID(), data = source.load(); data.telegram = {token:marker,chatId:'123'}; source.save(data);
  let mode = 'ok'; const requests: {url:string;body:any}[] = [];
  const server = createServer((req,res)=> { let text=''; req.on('data',d=>text+=d); req.on('end',()=>{
    requests.push({url:req.url!,body:JSON.parse(text)});
    if(mode==='hang') { res.writeHead(200, {'Content-Type':'application/json'}); res.write('{'); return; }
    if(mode==='error') {res.writeHead(401);res.end(marker);return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:req.url!.endsWith('getUpdates') ? [{message:{chat:{id:123,type:'private'}}},{message:{chat:{id:999,type:'group'}}}] : {message_id:1}}));
  });}); server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));
  const telegram = new Telegram(source,`http://127.0.0.1:${(server.address() as {port:number}).port}`,100);
  try {
    assert.equal(await telegram.send('Test '+marker),true); assert.equal(requests[0].url,`/bot${marker}/sendMessage`);
    assert.equal(requests[0].body.chat_id,'123');assert.equal(requests[0].body.text.includes(marker),false);assert.equal(redact(marker).includes(marker),false);
    assert.deepEqual(await telegram.detect(),['123']);assert.equal(requests[1].body.timeout,0);
    mode='error';assert.equal(await telegram.send('test'),false);assert.deepEqual(await telegram.detect(),[]);
    mode='hang';const started=Date.now();telegram.notify('Attention');assert.ok(Date.now()-started<50);
    assert.equal(await telegram.send('Bounded'),false);assert.ok(Date.now()-started<1500);
    await new Promise(r=>setTimeout(r,150));assert.equal(telegram.pending,0);
    assert.equal(logs.join(' ').includes(marker),false);
    data.telegram.token='';source.save(data);assert.equal(await telegram.send('Disconnected'),false);
  } finally { server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true}); }
});
