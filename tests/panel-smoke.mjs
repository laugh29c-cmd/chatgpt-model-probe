import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(require.resolve('playwright',{paths:[process.env.PROBE_NODE_MODULES||process.cwd()]}));
const url=process.env.PROBE_PANEL_URL;if(!url)throw Error('PROBE_PANEL_URL required');
const browser=await chromium.launch({headless:true,...(process.env.PROBE_BROWSER_PATH?{executablePath:process.env.PROBE_BROWSER_PATH}:{})});
try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('#status').textContent==='未连接采集源');
  const denied=await fetch(url+'/api/control',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"login"}'});assert.equal(denied.status,403);
  const cross=await fetch(url+'/api/state',{headers:{Origin:'https://example.com'}});assert.equal(cross.status,403);
  await page.locator('#login').click();await page.waitForFunction(()=>document.querySelector('#login-status').textContent.startsWith('登录标记'));
  await page.locator('#network-tag').fill('fixture-network');await page.locator('#account-tag').fill('test-A');await page.locator('#tags').click();
  await page.locator('#network').click();await page.waitForFunction(()=>document.querySelector('#raw-network').textContent.includes('network_id'));
  const imported={records:[{id:'fixture',timestamp:new Date().toISOString(),surface:'work',requested_model:'gpt-request',provider_response_model:'gpt-returned',evidence_state:'provider_response_model',record_kind:'transport_fixture',network_tag:'fixture-network',diagnostics:{events:2,model_candidates:[]}}]};
  await page.locator('#file').setInputFiles({name:'fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('导入回执'));
  assert.equal(await page.locator('#model').textContent(),'gpt-returned');
  await page.screenshot({path:fileURLToPath(new URL('./artifacts/panel-desktop.png',import.meta.url))});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:fileURLToPath(new URL('./artifacts/panel-mobile.png',import.meta.url))});
  await page.locator('#collapse').click();assert.ok(await page.locator('body').evaluate(e=>e.classList.contains('compact')));
  if(await page.evaluate(()=>Boolean(window.documentPictureInPicture))){
    const popupPromise=page.waitForEvent('popup',{timeout:4000});await page.locator('#float').click();
    const popup=await popupPromise;await popup.locator('#collapse').click();await popup.close();await page.locator('main').waitFor();
  }
  assert.deepEqual(errors,[]);console.log('PASS panel: network readback, labels, imported evidence, mobile fit, collapse, floating-window controls, CSRF and origin rejection.');
}finally{await browser.close();}
