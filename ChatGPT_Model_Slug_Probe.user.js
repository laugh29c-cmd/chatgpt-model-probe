// ==UserScript==
// @name         ChatGPT Model Slug Probe
// @namespace    chatgpt-model-probe
// @version      1.4.0
// @description  Observe ChatGPT model metadata/timing and keep a local per-turn Daily Ledger for longitudinal routing analysis.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const W=window;
  if(W.__CHATGPT_MODEL_PROBE_140__) return;
  W.__CHATGPT_MODEL_PROBE_140__=true;

  const nativeFetch=W.fetch.bind(W);
  const CONV_RE=/^\/c\/([0-9a-f-]{20,})(?:\/|$)/i;
  const HISTORY_RE=/^\/backend-api\/(?:f\/)?conversation\/([0-9a-f-]{20,})\/?$/i;
  const STREAM_RE=/^\/backend-api\/(?:f\/)?conversation\/?$/i;
  const UI_KEY='chatgpt-model-probe-ui-v140';
  const DB_NAME='chatgpt-model-probe', DB_VER=1, STORE='turns', RETENTION_DAYS=14;
  const now=()=>performance.now();
  const str=v=>typeof v==='string'&&v.trim()?v.trim():null;
  const pageId=()=>location.pathname.match(CONV_RE)?.[1]||null;
  const charCount=t=>Array.from(t).length;
  const dayKey=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fmtMs=v=>v==null||!Number.isFinite(v)||v<0?'—':v<1000?`${Math.round(v)} ms`:`${(v/1000).toFixed(2)} s`;
  const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

  let epoch=0,serial=0,active=null,timer=null,panel=null,drag=null,currentPath=location.pathname,pageConversationId=pageId();
  let ui=loadUi(),view=emptyView('等待新回复');
  let dbPromise=null,ledgerError=null;
  let today={day:dayKey(),count:0,slugMismatch:0,steMismatch:0,parseMissTurns:0,suspicious:0,medianTtftMs:null,medianTotalMs:null,medianCharsPerSec:null};

  function emptyView(status){return{requested:null,message:null,resolved:null,ste:null,status,turn:null};}
  function current(t){return active===t&&t.epoch===epoch;}
  function loadUi(){try{const v=JSON.parse(localStorage.getItem(UI_KEY)||'{}');return{left:Number.isFinite(v.left)?v.left:null,top:Number.isFinite(v.top)?v.top:null,collapsed:v.collapsed===true};}catch{return{left:null,top:null,collapsed:false};}}
  function saveUi(){try{localStorage.setItem(UI_KEY,JSON.stringify(ui));}catch{}}
  function median(a){const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;}

  function openDb(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      if(!('indexedDB'in W)) return reject(new Error('IndexedDB unavailable'));
      const r=indexedDB.open(DB_NAME,DB_VER);
      r.onupgradeneeded=()=>{
        const db=r.result;
        const s=db.objectStoreNames.contains(STORE)?r.transaction.objectStore(STORE):db.createObjectStore(STORE,{keyPath:'id'});
        if(!s.indexNames.contains('day')) s.createIndex('day','local_day',{unique:false});
      };
      r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();resolve(db);};
      r.onerror=()=>reject(r.error||new Error('IndexedDB open failed'));
    });
    dbPromise.catch(e=>{ledgerError=e?.message||'IndexedDB error';render();});
    return dbPromise;
  }
  async function dbPut(rec){const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(rec);tx.oncomplete=res;tx.onerror=tx.onabort=()=>rej(tx.error||new Error('ledger write failed'));});}
  async function dbDay(day){const db=await openDb();return await new Promise((res,rej)=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).index('day').getAll(IDBKeyRange.only(day));r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error||new Error('ledger read failed'));});}
  async function dbClear(){const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).clear();tx.oncomplete=res;tx.onerror=tx.onabort=()=>rej(tx.error||new Error('ledger clear failed'));});}
  async function dbLabel(id,label){const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE),r=s.get(id);r.onsuccess=()=>{if(!r.result)return;const x=r.result;x.behavior_label=label;x.label_updated_at=new Date().toISOString();s.put(x);};tx.oncomplete=res;tx.onerror=tx.onabort=()=>rej(tx.error||new Error('ledger label failed'));});}
  async function prune(){try{const db=await openDb(),cut=Date.now()-RETENTION_DAYS*86400000;const all=await new Promise((res,rej)=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error);});const stale=all.filter(x=>Date.parse(x.timestamp||'')<cut);if(!stale.length)return;await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE);for(const x of stale)s.delete(x.id);tx.oncomplete=res;tx.onerror=tx.onabort=()=>rej(tx.error);});}catch(e){ledgerError=e?.message||'ledger prune failed';}}
  async function refreshToday(){try{const day=dayKey(),r=await dbDay(day),valid=r.filter(x=>x.parse_misses===0);today={day,count:r.length,slugMismatch:r.filter(x=>x.slug_mismatch).length,steMismatch:r.filter(x=>x.ste_mismatch).length,parseMissTurns:r.filter(x=>x.parse_misses>0).length,suspicious:r.filter(x=>['suspicious','drift'].includes(x.behavior_label)).length,medianTtftMs:median(valid.map(x=>x.first_answer_ms)),medianTotalMs:median(r.map(x=>x.total_ms)),medianCharsPerSec:median(valid.map(x=>x.chars_per_sec))};ledgerError=null;render();}catch(e){ledgerError=e?.message||'ledger read failed';render();}}

  function mismatchSnapshot(s){
    const n=v=>v?.toLowerCase(),reported=[s.message,s.resolved,s.ste].filter(Boolean),auto=/^(?:auto|router)(?:[-_].*)?$/i.test(s.requested||''),values=auto?reported:[s.requested,...reported].filter(Boolean),base=[s.resolved,s.message,auto?null:s.requested].filter(Boolean);
    return{slugMismatch:new Set(values.map(n)).size>1,steMismatch:Boolean(s.ste)&&base.some(v=>n(v)!==n(s.ste))};
  }
  function rates(t){const span=t&&t.lastAnswer!=null&&t.firstAnswer!=null?t.lastAnswer-t.firstAnswer:0,charsPerSec=t&&span>=100&&t.answerChars>t.firstAnswerChars?(t.answerChars-t.firstAnswerChars)/(span/1000):null,wire=t?.firstByte!=null&&t?.end!=null?(t.end-t.firstByte)/1000:0;return{charsPerSec,sseKibPerSec:wire>=.1?t.bytes/1024/wire:null};}
  function ledgerRecord(t,status){const s={requested:view.requested,message:view.message,resolved:view.resolved,ste:view.ste},m=mismatchSnapshot(s),r=rates(t),elapsed=k=>t[k]!=null?t[k]-t.started:null;return{schema:'chatgpt-model-probe-ledger/v1',id:t.ledgerId,timestamp:new Date(t.wallStarted).toISOString(),ended_at:new Date().toISOString(),local_day:dayKey(new Date(t.wallStarted)),session_turn:t.id,conversation_id:t.conversationId||pageId()||null,requested_model:s.requested,message_model_slug:s.message,resolved_model_slug:s.resolved,server_ste_model_slug:s.ste,slug_mismatch:m.slugMismatch,ste_mismatch:m.steMismatch,headers_ms:elapsed('headers'),first_byte_ms:elapsed('firstByte'),first_text_ms:elapsed('firstText'),first_answer_ms:elapsed('firstAnswer'),total_ms:t.end!=null?t.end-t.started:null,answer_chars:t.answerChars,chars_per_sec:r.charsPerSec,sse_kib_per_sec:r.sseKibPerSec,parse_misses:t.parseMisses,text_stats_complete:t.parseMisses===0,status,behavior_label:t.behaviorLabel||null};}
  async function persist(t,status){if(!t||t.ledgerState!=='unsaved')return;t.ledgerState='saving';const rec=ledgerRecord(t,status);try{await dbPut(rec);t.ledgerState='saved';ledgerError=null;await prune();await refreshToday();}catch(e){t.ledgerState='error';ledgerError=e?.message||'ledger write failed';render();}}
  async function setLabel(label){const t=view.turn;if(!t?.ledgerId||t.ledgerState!=='saved')return;t.behaviorLabel=label;try{await dbLabel(t.ledgerId,label);await refreshToday();}catch(e){ledgerError=e?.message||'label update failed';render();}}

  function csvCell(v){if(v==null)return'';return`"${String(v).replace(/"/g,'""')}"`;}
  function downloadText(text,type,name){const b=new Blob([text],{type}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;a.style.display='none';document.documentElement.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  async function exportToday(format){try{const day=dayKey(),r=await dbDay(day);if(format==='json'){downloadText(JSON.stringify({schema:'chatgpt-model-probe-daily-export/v1',exported_at:new Date().toISOString(),local_day:day,retention_days:RETENTION_DAYS,record_count:r.length,records:r},null,2),'application/json;charset=utf-8',`chatgpt-model-probe_${day}.json`);return;}const f=['timestamp','ended_at','local_day','session_turn','conversation_id','requested_model','message_model_slug','resolved_model_slug','server_ste_model_slug','slug_mismatch','ste_mismatch','headers_ms','first_byte_ms','first_text_ms','first_answer_ms','total_ms','answer_chars','chars_per_sec','sse_kib_per_sec','parse_misses','text_stats_complete','status','behavior_label'];const lines=[f.join(','),...r.map(x=>f.map(k=>csvCell(x[k])).join(','))];downloadText('\ufeff'+lines.join('\n'),'text/csv;charset=utf-8',`chatgpt-model-probe_${day}.csv`);}catch(e){ledgerError=e?.message||'export failed';render();}}
  async function copySummary(){await refreshToday();const s=[`ChatGPT Model Probe · ${today.day}`,`turns: ${today.count}`,`slug mismatch: ${today.slugMismatch}`,`STE mismatch: ${today.steMismatch}`,`behavior suspicious/drift: ${today.suspicious}`,`parse-miss turns: ${today.parseMissTurns}`,`median TTFT: ${fmtMs(today.medianTtftMs)}`,`median total: ${fmtMs(today.medianTotalMs)}`,`median chars/s: ${Number.isFinite(today.medianCharsPerSec)?today.medianCharsPerSec.toFixed(1):'—'}`].join('\n');try{await navigator.clipboard.writeText(s);}catch{const a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;opacity:0';document.documentElement.appendChild(a);a.select();document.execCommand('copy');a.remove();}}

  function requestUrl(input){try{return new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);}catch{return null;}}
  async function requestPayload(input,init){try{let body;if(init?.body!=null)body=init.body;else if(input instanceof Request)return JSON.parse(await input.clone().text());if(typeof body==='string')return JSON.parse(body);if(body instanceof Blob)return JSON.parse(await body.text());if(body instanceof ArrayBuffer||ArrayBuffer.isView(body))return JSON.parse(new TextDecoder().decode(body));}catch{}return null;}

  function beginTurn(){
    onNavigation();
    if(active&&active.end===null) finish(active,'已被新轮次替代');
    if(active?.reader) void active.reader.cancel().catch(()=>{});
    const t={id:++serial,epoch,conversationId:pageId(),ledgerId:crypto.randomUUID?.()||`${Date.now()}-${serial}-${Math.random().toString(16).slice(2)}`,ledgerState:'unsaved',behaviorLabel:null,wallStarted:Date.now(),started:now(),headers:null,firstByte:null,firstText:null,firstAnswer:null,lastAnswer:null,end:null,bytes:0,answerChars:0,firstAnswerChars:0,messages:new Map(),doc:{},patchPath:'',patchOp:null,reader:null,protocolDone:false,parseMisses:0};
    active=t;view=emptyView('请求中');view.turn=t;if(timer!==null)clearInterval(timer);timer=setInterval(render,250);render();return t;
  }
  function finish(t,status){if(!current(t)||t.end!==null)return;t.end=now();view.status=status;if(timer!==null)clearInterval(timer);timer=null;render();void persist(t,status);}
  function messageMetadata(md){if(!md||typeof md!=='object')return;if(Object.hasOwn(md,'model_slug'))view.message=str(md.model_slug);if(Object.hasOwn(md,'resolved_model_slug'))view.resolved=str(md.resolved_model_slug);}
  function acceptConversation(t,id){if(!str(id))return true;if(t.conversationId&&t.conversationId!==id)return false;t.conversationId=id;return true;}
  function inspectMessage(t,m,path=''){if(m?.author?.role!=='assistant')return;messageMetadata(m.metadata);const c=m.content;if(!c||!['text','multimodal_text'].includes(c.content_type)||!Array.isArray(c.parts))return;const text=c.parts.filter(p=>typeof p==='string').join(''),key=m.id||`anonymous:${path}`,prev=t.messages.get(key),stamp=now(),answer=(!m.channel||m.channel==='final')&&(!m.recipient||m.recipient==='all'),count=charCount(text);if(text.length&&t.firstText===null)t.firstText=stamp;t.messages.set(key,{text,chars:count,answer});if(answer&&text.length&&(!prev||prev.text!==text||!prev.answer)){if(t.firstAnswer===null){t.firstAnswer=stamp;t.firstAnswerChars=count;}t.lastAnswer=stamp;}t.answerChars=Array.from(t.messages.values()).reduce((n,x)=>n+(x.answer?x.chars:0),0);}
  function scan(t,o,path='',depth=0){if(!o||typeof o!=='object'||depth>10)return;if(o.author?.role){inspectMessage(t,o,path);return;}if(o.type==='server_ste_metadata'){if(acceptConversation(t,o.conversation_id))view.ste=str(o.metadata?.model_slug);return;}if(o.conversation_id&&!acceptConversation(t,o.conversation_id))return;for(const[k,v]of Object.entries(o)){if(['metadata','content','author'].includes(k))continue;if(v&&typeof v==='object')scan(t,v,`${path}/${k}`,depth+1);}}
  function pointer(path){if(path==='')return[];if(typeof path!=='string'||!path.startsWith('/'))throw new Error('path');const keys=path.slice(1).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~'));if(keys.some(k=>['__proto__','prototype','constructor'].includes(k)))throw new Error('key');return keys;}
  function patch(t,path,op,value){const keys=pointer(path);if(!keys.length){if(op==='add'||op==='replace')t.doc=value;else if(op==='remove')t.doc={};else throw new Error('root operation');return;}let p=t.doc;for(const k of keys.slice(0,-1)){if(!p||typeof p!=='object'||!Object.hasOwn(p,k))throw new Error('parent');p=p[k];}if(!p||typeof p!=='object')throw new Error('parent');const k=keys.at(-1);if(op==='append'){if(typeof p[k]==='string'&&typeof value==='string')p[k]+=value;else if(Array.isArray(p[k]))p[k].push(...(Array.isArray(value)?value:[value]));else throw new Error('append');}else if(op==='add'){if(Array.isArray(p)){const i=k==='-'?p.length:Number(k);if(!Number.isInteger(i)||i<0||i>p.length)throw new Error('index');p.splice(i,0,value);}else p[k]=value;}else if(op==='replace'){if(!Object.hasOwn(p,k))throw new Error('replace');p[k]=value;}else if(op==='remove'){if(Array.isArray(p))p.splice(Number(k),1);else delete p[k];}else throw new Error('operation');}
  function ingest(t,o,inPath=null,inOp=null){if(!current(t)||!o||typeof o!=='object')return;if(Array.isArray(o)){for(const x of o)ingest(t,x);return;}if(o.conversation_id&&!acceptConversation(t,o.conversation_id))return;if(o.type==='server_ste_metadata'){view.ste=str(o.metadata?.model_slug);return;}if(Object.hasOwn(o,'v')){const path=o.p??inPath??t.patchPath,op=o.o??inOp??t.patchOp;if(op==='patch'&&Array.isArray(o.v)){for(const x of o.v)ingest(t,{...x,p:`${path||''}${x.p||''}`});return;}if(op){t.patchPath=path;t.patchOp=op;try{patch(t,path,op,o.v);scan(t,t.doc);}catch{t.parseMisses++;scan(t,o.v);}return;}scan(t,o.v);}if(o.message)t.doc=o;scan(t,o);}

  async function inspectStream(response,t){
    if(!current(t))return;if(!response.ok)return finish(t,`HTTP ${response.status}`);if(!((response.headers.get('content-type')||'').includes('text/event-stream')))return finish(t,'非 SSE 响应，未测输出');if(!response.body)return finish(t,'无响应体');
    let reader;try{reader=response.clone().body.getReader();t.reader=reader;const dec=new TextDecoder();let buf='',lines=[],eventName='',skipLF=false;
      function event(){const data=lines.join('\n');lines=[];const name=eventName;eventName='';if(!data)return;if(data==='[DONE]'){t.protocolDone=true;finish(t,'完成');return;}try{const o=JSON.parse(data);if(name==='server_ste_metadata'&&o&&typeof o==='object'&&!o.type)o.type=name;ingest(t,o);}catch{t.parseMisses++;}}
      function line(v){if(!v)return event();if(v.startsWith(':'))return;const i=v.indexOf(':'),k=i<0?v:v.slice(0,i);let x=i<0?'':v.slice(i+1);if(x.startsWith(' '))x=x.slice(1);if(k==='data')lines.push(x);else if(k==='event')eventName=x;}
      function feed(text){for(const ch of text){if(skipLF){skipLF=false;if(ch==='\n')continue;}if(ch==='\r'||ch==='\n'){line(buf);buf='';skipLF=ch==='\r';}else buf+=ch;}}
      for(;;){const{value,done}=await reader.read();if(!current(t))break;if(value?.byteLength){if(t.firstByte===null)t.firstByte=now();t.bytes+=value.byteLength;if(t.end===null)view.status='接收中';}feed(dec.decode(value||new Uint8Array(),{stream:!done}));if(t.protocolDone||done){if(done&&!t.protocolDone){if(buf)line(buf);if(lines.length)event();finish(t,'流已结束（未见 DONE）');}break;}}
    }catch(e){finish(t,e?.name==='AbortError'?'已中止':'流读取失败');}finally{if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}t.reader=null;t.doc={};t.messages.clear();if(current(t))render();}}

  async function inspectHistory(response,id,capEpoch,capSerial){if(!response.ok||!((response.headers.get('content-type')||'').includes('application/json')))return;try{const json=await response.clone().json();if(epoch!==capEpoch||serial!==capSerial||active||pageId()!==id)return;if((json.id||json.conversation_id||id)!==id||!json.mapping)return;let node=json.current_node;const seen=new Set();while(node&&!seen.has(node)){seen.add(node);const e=json.mapping[node];if(!e)break;if(e.message?.author?.role==='assistant'){view=emptyView('历史消息；计时需重新发起回复');messageMetadata(e.message.metadata);render();return;}node=e.parent;}}catch{}}

  W.fetch=async function(input,init){const url=requestUrl(input),local=url?.origin===location.origin,method=String(init?.method||input?.method||'GET').toUpperCase(),isStream=local&&method==='POST'&&STREAM_RE.test(url.pathname),id=local&&method==='GET'?url.pathname.match(HISTORY_RE)?.[1]:null;let t=null;if(isStream){const payload=requestPayload(input,init);t=beginTurn();void payload.then(body=>{if(!current(t))return;view.requested=str(body?.model);if(str(body?.conversation_id))acceptConversation(t,body.conversation_id);render();});}const capEpoch=epoch,capSerial=serial;let response;try{response=await nativeFetch(input,init);}catch(e){if(t)finish(t,e?.name==='AbortError'?'已中止':'请求失败');throw e;}if(t&&current(t)){t.headers=now();void inspectStream(response,t);}else if(id)void inspectHistory(response,id,capEpoch,capSerial);return response;};

  function onNavigation(){const path=location.pathname,id=pageId();if(path===currentPath)return;currentPath=path;if(id&&active?.conversationId===id&&pageConversationId===null){pageConversationId=id;render();return;}if(id&&id===pageConversationId)return;pageConversationId=id;if(active&&active.end===null)finish(active,'会话切换');epoch++;if(active?.reader)void active.reader.cancel().catch(()=>{});active=null;if(timer!==null)clearInterval(timer);timer=null;view=emptyView('已切换会话；等待消息数据');render();}
  for(const name of['pushState','replaceState']){const orig=history[name];history[name]=function(...args){const r=orig.apply(this,args);onNavigation();return r;};}
  addEventListener('popstate',onNavigation,true);
  queueMicrotask(async()=>{const id=pageId(),capEpoch=epoch,capSerial=serial;if(!id||active)return;try{const r=await nativeFetch(`/backend-api/conversation/${encodeURIComponent(id)}`,{credentials:'same-origin'});await inspectHistory(r,id,capEpoch,capSerial);}catch{}});

  function pos(left,top,persist=false){if(!panel?.isConnected)return;const x=Math.min(Math.max(0,innerWidth-panel.offsetWidth),Math.max(0,left)),y=Math.min(Math.max(0,innerHeight-panel.offsetHeight),Math.max(0,top));panel.style.left=`${x}px`;panel.style.top=`${y}px`;panel.style.right='auto';panel.style.bottom='auto';if(persist){ui.left=x;ui.top=y;saveUi();}}
  function applyPos(){if(Number.isFinite(ui.left)&&Number.isFinite(ui.top))pos(ui.left,ui.top);else{panel.style.left='auto';panel.style.top='auto';panel.style.right='14px';panel.style.bottom='14px';}}
  function clamp(persist=false){if(panel?.isConnected&&Number.isFinite(ui.left)&&Number.isFinite(ui.top))pos(ui.left,ui.top,persist);}
  function button(label,action,active=false){return`<button type="button" data-probe-action="${action}" style="border:1px solid #555;border-radius:6px;padding:2px 7px;background:${active?'#454545':'#2c2c2c'};color:#f4f4f4;font:inherit;cursor:pointer">${label}</button>`;}
  function installUi(){if(!panel||panel.dataset.ready==='1')return;panel.dataset.ready='1';panel.addEventListener('pointerdown',e=>{if(e.button!==0||!(e.target instanceof Element)||e.target.closest('[data-probe-action]'))return;const h=e.target.closest('[data-probe-drag-handle]');if(!h||!panel.contains(h))return;const r=panel.getBoundingClientRect();drag={id:e.pointerId,dx:e.clientX-r.left,dy:e.clientY-r.top};panel.style.left=`${r.left}px`;panel.style.top=`${r.top}px`;panel.style.right='auto';panel.style.bottom='auto';panel.setPointerCapture?.(e.pointerId);e.preventDefault();});panel.addEventListener('pointermove',e=>{if(drag?.id===e.pointerId)pos(e.clientX-drag.dx,e.clientY-drag.dy);});const end=e=>{if(drag?.id!==e.pointerId)return;drag=null;const r=panel.getBoundingClientRect();ui.left=r.left;ui.top=r.top;saveUi();try{panel.releasePointerCapture?.(e.pointerId);}catch{}};panel.addEventListener('pointerup',end);panel.addEventListener('pointercancel',end);panel.addEventListener('click',e=>{if(!(e.target instanceof Element))return;const b=e.target.closest('[data-probe-action]');if(!b||!panel.contains(b))return;const a=b.dataset.probeAction;if(a==='collapse'){ui.collapsed=!ui.collapsed;saveUi();return render();}if(a==='export-json')return void exportToday('json');if(a==='export-csv')return void exportToday('csv');if(a==='copy-summary')return void copySummary();if(a==='label-normal')return void setLabel('normal');if(a==='label-suspicious')return void setLabel('suspicious');if(a==='label-drift')return void setLabel('drift');if(a==='clear-ledger'){if(confirm('清空 ChatGPT Model Probe 的全部本地日志？\n\n只会删除探针 IndexedDB 记录。'))void dbClear().then(refreshToday).catch(x=>{ledgerError=x?.message||'ledger clear failed';render();});}});}
  addEventListener('resize',()=>clamp(true),{passive:true});

  function render(){
    if(!panel?.isConnected){const host=document.body||document.documentElement;if(!host)return;panel=document.createElement('div');panel.id='tm-chatgpt-model-slug-probe';panel.style.cssText='position:fixed;right:14px;bottom:14px;z-index:2147483647;width:390px;max-width:calc(100vw - 28px);box-sizing:border-box;padding:11px 13px;background:rgba(20,20,20,.93);color:#f4f4f4;border:1px solid #555;border-radius:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 6px 24px #0004;pointer-events:auto;overflow-wrap:anywhere';host.appendChild(panel);installUi();applyPos();}
    const t=view.turn,delay=k=>t?.[k]!=null?fmtMs(t[k]-t.started):'—',m=mismatchSnapshot(view),r=rates({...t,end:t?.end??now()}),row=(k,v)=>`<div style="display:grid;grid-template-columns:190px minmax(0,1fr);gap:8px"><span style="opacity:.7">${esc(k)}</span><span>${esc(v)}</span></div>`;
    panel.style.borderColor=m.slugMismatch?'#e6b85c':'#555';
    const header=`<div data-probe-drag-handle="1" style="display:flex;align-items:center;justify-content:space-between;gap:12px;${ui.collapsed?'':'margin-bottom:6px;'}cursor:move;user-select:none;touch-action:none"><span style="font-weight:700">ChatGPT metadata · v1.4.0</span>${button(ui.collapsed?'展开':'收起','collapse')}</div>`;
    panel.style.width=ui.collapsed?'280px':'390px';if(ui.collapsed){panel.innerHTML=header;clamp();return;}
    const parseWarn=t?.parseMisses?' · 存在未解析事件，文本统计可能不完整':'',ledgerState=t?.ledgerState==='saving'?' · 日志保存中':t?.ledgerState==='saved'?' · 已写入 Daily Ledger':t?.ledgerState==='error'?' · 日志写入失败':'';
    panel.innerHTML=header+(m.slugMismatch?'<div style="color:#e6b85c;margin-bottom:5px">字段有差异（可能是别名/路由，不能据此判定降级）</div>':'')+row('requested (body.model)',view.requested)+row('message.model_slug',view.message)+row('resolved_model_slug',view.resolved)+row('server STE model_slug',view.ste)+'<div style="border-top:1px solid #444;margin:7px 0"></div>'+row('响应头到达',delay('headers'))+row('首数据块（非 TTFT）',delay('firstByte'))+row('首段文本（含可见思考）',delay('firstText'))+row('首段正文（TTFT 近似）',delay('firstAnswer'))+row('本轮耗时',t?fmtMs((t.end??now())-t.started):'—')+row('正文速度（近似）',Number.isFinite(r.charsPerSec)?`${r.charsPerSec.toFixed(1)} 字符/s`:'—')+row('已识别正文字符',t?.firstAnswer!=null?t.answerChars:'—')+row('SSE 数据速率（含协议）',Number.isFinite(r.sseKibPerSec)?`${r.sseKibPerSec.toFixed(1)} KiB/s`:'—')+`<div style="opacity:.65;margin-top:7px">${esc(view.status)}${parseWarn}${ledgerState}</div><div style="border-top:1px solid #444;margin:7px 0"></div><div style="opacity:.75;margin-bottom:5px">今日 Ledger · ${esc(today.day)} · ${today.count} 轮 · mismatch ${today.slugMismatch} · STE mismatch ${today.steMismatch} · 标记异常 ${today.suspicious}</div><div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px">${button('导出今日 JSON','export-json')}${button('CSV','export-csv')}${button('复制今日摘要','copy-summary')}${button('清空日志','clear-ledger')}</div>${t?.end!=null?`<div style="display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-bottom:5px"><span style="opacity:.7">本轮行为：</span>${button('正常','label-normal',t.behaviorLabel==='normal')}${button('可疑','label-suspicious',t.behaviorLabel==='suspicious')}${button('明显漂移','label-drift',t.behaviorLabel==='drift')}</div>`:''}${ledgerError?`<div style="color:#e6b85c;margin-bottom:5px">Daily Ledger: ${esc(ledgerError)}</div>`:''}<div style="opacity:.5;font-size:11px;margin-top:3px">客户端收包计时；首数据不是首 token。正文按已识别文本统计，不是 tokens/s；单批输出不估速。网络、排队、缓冲与负载都会影响速度。<br>Daily Ledger 只存模型字段、计时、计数、conversation id 和人工标签；不保存聊天正文，默认保留 14 天。</div>`;
    clamp();
  }

  void prune();void refreshToday();
  if(document.documentElement)render();else new MutationObserver((_,o)=>{if(document.documentElement){o.disconnect();render();}}).observe(document,{childList:true,subtree:true});
})();
