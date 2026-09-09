import http from 'node:http';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Observer,listTargets} from '../src/cdp.mjs';
import net from 'node:net';
const require=createRequire(import.meta.url);
const {chromium}=require(require.resolve('playwright',{paths:[process.env.PROBE_NODE_MODULES||process.cwd()]}));
let releaseSlow;
const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Probe test fixture</title><main>Transport fixture</main>');return;}
  if(req.url==='/api/work/json'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({params:{turn:{model:'gpt-work-candidate'}}}));return;}
  if(req.url==='/api/work/ndjson'){res.writeHead(200,{'content-type':'application/x-ndjson'});res.end('{"response":{"object":"response","model":"gpt-ndjson"}}\n');return;}
  if(req.url==='/backend-api/conversation'){
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({message:{id:'m1',author:{role:'assistant'},metadata:{model_slug:'gpt-chat',resolved_model_slug:'gpt-chat'},content:{content_type:'text',parts:['PRIVATE_SENTINEL']}}})+'\r\n\r\n');setTimeout(()=>res.end('event: server_ste_metadata\r\ndata: {"metadata":{"model_slug":"gpt-ste"}}\r\n\r\ndata: [DONE]\r\n\r\n'),30);return;
  }
  if(req.url==='/backend-api/work/responses'||req.url==='/backend-api/work/slow'){
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: response.created\ndata: {"response":{"object":"response","model":"gpt-work"}}\n\n');
    if(req.url.endsWith('slow'))releaseSlow=()=>res.end('data: [DONE]\n\n');else setTimeout(()=>res.end('data: [DONE]\n\n'),30);return;
  }
  res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
let browser;
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const cdpPort=reserve.address().port;await new Promise(r=>reserve.close(r));
try{
  browser=await chromium.launch({headless:true,args:['--remote-debugging-port='+cdpPort,'--remote-debugging-address=127.0.0.1'],...(process.env.PROBE_BROWSER_PATH?{executablePath:process.env.PROBE_BROWSER_PATH}:{})});const page=await browser.newPage({viewport:{width:1365,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript({path:fileURLToPath(new URL('../ChatGPT_Model_Slug_Probe.user.js',import.meta.url))});
  await page.goto(origin);await page.locator('#tm-chatgpt-model-slug-probe').waitFor();
  const send=url=>page.evaluate(async url=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-request',mode:'work',messages:[{content:'PRIVATE_PROMPT'}]})});return response.text();},url);
  const chat=await send('/backend-api/conversation');assert.ok(chat.includes('PRIVATE_SENTINEL'));
  await page.waitForFunction(()=>document.querySelector('#tm-chatgpt-model-slug-probe').textContent.includes('gpt-ste'));
  await send('/backend-api/work/responses');await page.waitForFunction(()=>document.querySelector('#tm-chatgpt-model-slug-probe').textContent.includes('provider_response_model'));
  await send('/api/work/ndjson');await page.waitForFunction(()=>document.querySelector('#tm-chatgpt-model-slug-probe').textContent.includes('gpt-ndjson'));
  await send('/api/work/json');await page.waitForFunction(()=>document.querySelector('#tm-chatgpt-model-slug-probe').textContent.includes('gpt-work-candidate'));
  assert.ok((await page.locator('#tm-chatgpt-model-slug-probe').textContent()).includes('requested_only'));
  await page.evaluate(()=>{window.slowResult=fetch('/backend-api/work/slow',{method:'POST',body:'{"model":"gpt-request"}'}).then(r=>r.text());});
  await page.waitForFunction(()=>document.querySelector('#tm-chatgpt-model-slug-probe').textContent.includes('gpt-work'));
  await page.locator('[data-probe-action="toggle"]').click();releaseSlow();assert.ok((await page.evaluate(()=>window.slowResult)).includes('[DONE]'));
  await page.locator('[data-probe-action="toggle"]').click();await send('/backend-api/work/responses');
  await page.waitForTimeout(150);
  const ledger=await page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('chatgpt-model-probe');req.onsuccess=()=>{const q=req.result.transaction('turns').objectStore('turns').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=reject;};req.onerror=reject;}));
  assert.ok(ledger.length>=5);assert.ok(!JSON.stringify(ledger).includes('PRIVATE_SENTINEL'));assert.ok(!JSON.stringify(ledger).includes('PRIVATE_PROMPT'));
  fs.mkdirSync(new URL('./artifacts/',import.meta.url),{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL('./artifacts/browser-desktop.png',import.meta.url))});
  await page.setViewportSize({width:390,height:844});
  const box=await page.locator('#tm-chatgpt-model-slug-probe').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=391&&box.y+box.height<=845);
  await page.screenshot({path:fileURLToPath(new URL('./artifacts/browser-mobile.png',import.meta.url))});
  await page.locator('[data-probe-action="collapse"]').click();assert.ok((await page.locator('#tm-chatgpt-model-slug-probe').boundingBox()).height<160);
  assert.deepEqual(errors,[]);console.log('PASS browser: original Chat, Work SSE/JSON/NDJSON, candidate evidence, pause without aborting caller, metadata-only ledger, desktop/mobile layout. Records='+ledger.length);
  const target=(await listTargets('http://127.0.0.1:'+cdpPort)).find(t=>t.url===origin+'/');assert.ok(target);
  const receipts=[],observer=new Observer(target,{onRecord:r=>receipts.push(r),onStatus:()=>{}});
  try{
    await observer.connect();await page.evaluate(()=>{window.cdpSlow=fetch('/backend-api/work/slow',{method:'POST',body:'{"model":"gpt-request"}'}).then(r=>r.text());});
    const deadline=Date.now()+8000;while(!receipts.some(r=>r.provider_response_model==='gpt-work')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
    assert.ok(receipts.some(r=>r.provider_response_model==='gpt-work'&&r.coverage==='live_stream'&&r.status==='metadata_received'),'CDP metadata must arrive before request completion');
    releaseSlow();await page.evaluate(()=>window.cdpSlow);assert.ok(!JSON.stringify(receipts).includes('PRIVATE_SENTINEL'));
    console.log('PASS real browser CDP: live metadata received before SSE connection closes.');
  }finally{observer.close();releaseSlow?.();}
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
