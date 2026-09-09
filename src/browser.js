// ==UserScript==
// @name         ChatGPT Model Slug Probe
// @namespace    chatgpt-model-probe
// @version      1.5.1
// @description  Observe ChatGPT Chat/Work model metadata/timing with generalized SSE detection and a local per-turn Daily Ledger.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @sandbox      raw
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const W=window;
  if(W.__CHATGPT_MODEL_PROBE_151__) return;
  W.__CHATGPT_MODEL_PROBE_151__=true;
  /* PROBE_CORE */

  const nativeFetch=W.fetch.bind(W);
  const CONV_RE=/(?:^|\/)c\/([0-9a-f-]{20,})(?:\/|$)/i;
  const HISTORY_RE=/^\/backend-api\/(?:f\/)?conversation\/([0-9a-f-]{20,})\/?$/i;
  const STREAM_RE=/^\/backend-api\/(?:f\/)?conversation\/?$/i;
  const BACKEND_RE=/^\/backend-api\//i;
  const UI_KEY='chatgpt-model-probe-ui-v150';
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
  let enabled=true,observerEpoch=0,pipWindow=null;
  let comparisonTag=ui.comparisonTag||'';
  const probeStarted=Date.now(),probeSession=crypto.randomUUID();
  let loginMarkedAt=null,networkChangedAt=null,networkRevision=0;
  function browserNetwork(){const c=navigator.connection||navigator.mozConnection||navigator.webkitConnection;return{revision:networkRevision,changed_at:networkChangedAt,online:navigator.onLine,connection_type:c?.type||'NOT_AVAILABLE',effective_type:c?.effectiveType||null,rtt_estimate_ms:c?.rtt??null,downlink_estimate_mbps:c?.downlink??null,save_data:c?.saveData??null,egress_ip:'NOT_OBSERVED',proxy:'NOT_AVAILABLE',dns:'NOT_AVAILABLE'};}
  const networkChanged=()=>{networkRevision++;networkChangedAt=new Date().toISOString();render();};
  addEventListener('online',networkChanged);addEventListener('offline',networkChanged);
  navigator.connection?.addEventListener('change',networkChanged);
  let today={day:dayKey(),count:0,slugMismatch:0,steMismatch:0,parseMissTurns:0,suspicious:0,medianTtftMs:null,medianTotalMs:null,medianCharsPerSec:null};

  function emptyView(status){return{diagnostics:{events:0,event_types:[],model_candidates:[]},requested:null,message:null,resolved:null,ste:null,provider:null,reroute:null,surface:null,endpoint:null,status,turn:null};}
  function current(t){return active===t&&t.epoch===epoch;}
  function loadUi(){try{const v=JSON.parse(localStorage.getItem(UI_KEY)||'{}');return{left:Number.isFinite(v.left)?v.left:null,top:Number.isFinite(v.top)?v.top:null,collapsed:v.collapsed===true,comparisonTag:typeof v.comparisonTag==='string'?v.comparisonTag.slice(0,60):''};}catch{return{left:null,top:null,collapsed:false};}}
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
  async function dbPut(rec){const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE);s.put(rec);const count=s.count();count.onsuccess=()=>{let excess=count.result-1000;if(excess>0){const cursor=s.index('day').openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(c&&excess-->0){c.delete();c.continue();}};}};tx.oncomplete=res;tx.onerror=tx.onabort=()=>rej(tx.error||new Error('ledger write failed'));});}
  async function dbDay(day){const db=await openDb();return await new Promise((res,rej)=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).index('day').getAll(IDBKeyRange.only(day),1000);r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error||new Error('ledger read failed'));});}
  async function dbClear(){const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).clear();tx.oncomplete=res;tx.onerror=tx.onabort=()=>rej(tx.error||new Error('ledger clear failed'));});}
  async function dbLabel(id,label){const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE),r=s.get(id);r.onsuccess=()=>{if(!r.result)return;const x=r.result;x.behavior_label=label;x.label_updated_at=new Date().toISOString();s.put(x);};tx.oncomplete=res;tx.onerror=tx.onabort=()=>rej(tx.error||new Error('ledger label failed'));});}
  async function prune(){try{const db=await openDb(),cut=Date.now()-RETENTION_DAYS*86400000;await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite'),r=tx.objectStore(STORE).openCursor();r.onsuccess=()=>{const c=r.result;if(c){if(Date.parse(c.value.timestamp||'')<cut)c.delete();c.continue();}};tx.oncomplete=res;tx.onerror=tx.onabort=()=>rej(tx.error);});}catch(e){ledgerError=e?.message||'ledger prune failed';}}
  async function refreshToday(){try{const day=dayKey(),r=await dbDay(day),valid=r.filter(x=>x.parse_misses===0);today={day,count:r.filter(x=>x.record_kind!=='transport_event').length,events:r.filter(x=>x.record_kind==='transport_event').length,slugMismatch:r.filter(x=>x.slug_mismatch).length,steMismatch:r.filter(x=>x.ste_mismatch).length,parseMissTurns:r.filter(x=>x.parse_misses>0).length,suspicious:r.filter(x=>['suspicious','drift'].includes(x.behavior_label)).length,medianTtftMs:median(valid.map(x=>x.first_answer_ms)),medianTotalMs:median(r.map(x=>x.total_ms)),medianCharsPerSec:median(valid.map(x=>x.chars_per_sec))};ledgerError=null;render();}catch(e){ledgerError=e?.message||'ledger read failed';render();}}

  function mismatchSnapshot(s){
    const n=v=>v?.toLowerCase(),reported=[s.message,s.resolved,s.ste,s.provider,s.reroute?.to_model].filter(Boolean),auto=/^(?:auto|router)(?:[-_].*)?$/i.test(s.requested||''),values=auto?reported:[s.requested,...reported].filter(Boolean),base=[s.resolved,s.message,auto?null:s.requested].filter(Boolean);
    return{slugMismatch:new Set(values.map(n)).size>1,steMismatch:Boolean(s.ste)&&base.some(v=>n(v)!==n(s.ste))};
  }
  function rates(t){const span=t&&t.lastAnswer!=null&&t.firstAnswer!=null?t.lastAnswer-t.firstAnswer:0,charsPerSec=t&&span>=100&&t.answerChars>t.firstAnswerChars?(t.answerChars-t.firstAnswerChars)/(span/1000):null,wire=t?.firstByte!=null&&t?.end!=null?(t.end-t.firstByte)/1000:0;return{charsPerSec,sseKibPerSec:wire>=.1?t.bytes/1024/wire:null};}
  function ledgerRecord(t,status){const s={requested:view.requested,message:view.message,resolved:view.resolved,ste:view.ste,provider:view.provider,reroute:view.reroute},m=mismatchSnapshot(s),r=rates(t),elapsed=k=>t[k]!=null?t[k]-t.started:null;return{schema:'chatgpt-model-probe-ledger/v3',probe_version:'1.5.1',record_kind:'request_observation',probe_session_id:probeSession,probe_elapsed_ms:t.wallStarted-probeStarted,comparison_tag:comparisonTag,login_marked_at:loginMarkedAt,login_elapsed_ms:loginMarkedAt?t.wallStarted-Date.parse(loginMarkedAt):null,network_at_start:t.network||null,network_at_end:browserNetwork(),http_status:t.httpStatus??null,content_type:t.contentType||null,provider_response_model:view.provider,reroute:view.reroute,diagnostics:view.diagnostics,observed_effective_reasoning:'NOT_AVAILABLE',id:t.ledgerId,timestamp:new Date(t.wallStarted).toISOString(),ended_at:new Date().toISOString(),local_day:dayKey(new Date(t.wallStarted)),session_turn:t.id,conversation_id:t.conversationId||pageId()||null,surface:t.surface||view.surface||'unknown',client:t.client||'web',endpoint:t.endpoint||view.endpoint||null,http_method:t.httpMethod||null,metadata_source:evidenceState(),evidence_state:evidenceState(),requested_model:s.requested,message_model_slug:s.message,resolved_model_slug:s.resolved,server_ste_model_slug:s.ste,slug_mismatch:m.slugMismatch,ste_mismatch:m.steMismatch,headers_ms:elapsed('headers'),first_byte_ms:elapsed('firstByte'),first_text_ms:elapsed('firstText'),first_answer_ms:elapsed('firstAnswer'),total_ms:t.end!=null?t.end-t.started:null,answer_chars:t.answerChars,chars_per_sec:r.charsPerSec,sse_kib_per_sec:r.sseKibPerSec,parse_misses:t.parseMisses,text_stats_complete:t.parseMisses===0,status,behavior_label:t.behaviorLabel||null};}
  async function persist(t,status){if(!t||t.ledgerState!=='unsaved')return;t.ledgerState='saving';const rec=ledgerRecord(t,status);try{await dbPut(rec);t.ledgerState='saved';ledgerError=null;await refreshToday();}catch(e){t.ledgerState='error';ledgerError=e?.message||'ledger write failed';render();}}
  async function setLabel(label){const t=view.turn;if(!t?.ledgerId||t.ledgerState!=='saved')return;t.behaviorLabel=label;try{await dbLabel(t.ledgerId,label);await refreshToday();}catch(e){ledgerError=e?.message||'label update failed';render();}}

  function csvCell(v){if(v==null)return'';let text=typeof v==='object'?JSON.stringify(v):String(v);if(/^[=+@\-\t\r]/.test(text))text="'"+text;return'"'+text.replace(/"/g,'""')+'"';}
  function downloadText(text,type,name){const b=new Blob([text],{type}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;a.style.display='none';document.documentElement.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  async function exportToday(format){try{const day=dayKey(),r=await dbDay(day);if(format==='json'){downloadText(JSON.stringify({schema:'chatgpt-model-probe-daily-export/v1',exported_at:new Date().toISOString(),local_day:day,retention_days:RETENTION_DAYS,record_count:r.length,records:r},null,2),'application/json;charset=utf-8',`chatgpt-model-probe_${day}.json`);return;}const f=['timestamp','ended_at','local_day','session_turn','conversation_id','surface','client','endpoint','http_method','metadata_source','evidence_state','requested_model','message_model_slug','resolved_model_slug','server_ste_model_slug','slug_mismatch','ste_mismatch','headers_ms','first_byte_ms','first_text_ms','first_answer_ms','total_ms','answer_chars','chars_per_sec','sse_kib_per_sec','parse_misses','text_stats_complete','status','behavior_label','comparison_tag','record_kind','probe_session_id','probe_elapsed_ms','login_marked_at','login_elapsed_ms','network_at_start','network_at_end','provider_response_model','reroute','http_status','content_type'];const lines=[f.join(','),...r.map(x=>f.map(k=>csvCell(x[k])).join(','))];downloadText('\ufeff'+lines.join('\n'),'text/csv;charset=utf-8',`chatgpt-model-probe_${day}.csv`);}catch(e){ledgerError=e?.message||'export failed';render();}}
  async function copySummary(){await refreshToday();const s=[`ChatGPT Model Probe · ${today.day}`,`turns: ${today.count}`,`slug mismatch: ${today.slugMismatch}`,`STE mismatch: ${today.steMismatch}`,`behavior suspicious/drift: ${today.suspicious}`,`parse-miss turns: ${today.parseMissTurns}`,`median TTFT: ${fmtMs(today.medianTtftMs)}`,`median total: ${fmtMs(today.medianTotalMs)}`,`median chars/s: ${Number.isFinite(today.medianCharsPerSec)?today.medianCharsPerSec.toFixed(1):'—'}`].join('\n');try{await navigator.clipboard.writeText(s);}catch{const a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;opacity:0';document.documentElement.appendChild(a);a.select();document.execCommand('copy');a.remove();}}

  function requestUrl(input){try{return new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);}catch{return null;}}
  async function requestPayload(input,init){
    try{
      let body=init?.body;
      if(body==null&&input instanceof Request){const reader=input.clone().body?.getReader();if(!reader)return null;let total=0,text='';const decoder=new TextDecoder();try{for(;;){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>128_000)return null;text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{void reader.cancel().catch(()=>{});}}
      if(typeof body==='string')return body.length<=128_000?JSON.parse(body):null;
      if(body instanceof Blob)return body.size<=128_000?JSON.parse(await body.text()):null;
      if(body instanceof ArrayBuffer||ArrayBuffer.isView(body))return body.byteLength<=128_000?JSON.parse(new TextDecoder().decode(body)):null;
    }catch{}return null;
  }

  function safeHints(o,depth=0,out=[]){if(!o||typeof o!=='object'||depth>4)return out;for(const[k,v]of Object.entries(o)){if(['messages','content','parts','prompt','text','input','instructions'].includes(k))continue;if(v&&typeof v==='object')safeHints(v,depth+1,out);else if(typeof v==='string'&&/(?:mode|surface|product|source|kind|feature|agent|work)/i.test(k))out.push(v.toLowerCase());}return out;}
  function inferSurface(url,body){const path=[location.pathname,url?.pathname||'',...safeHints(body)].join(' ').toLowerCase();if(/(?:^|[\/_-])work(?:$|[\/_-])/.test(path)||/(?:work_mode|agent_mode|deep_research)/.test(path))return'work';return'chat';}
  function evidenceState(){return Probe.evidenceState({requested_model:view.requested,message_model_slug:view.message,resolved_model_slug:view.resolved,server_ste_model_slug:view.ste,provider_response_model:view.provider,reroute:view.reroute});}
  function readEvidence(o){Probe.inspectShape(o,view.diagnostics);const acc=Probe.extractEvidence(o);if(acc.server_ste_model_slug)view.ste=acc.server_ste_model_slug;if(acc.message_model_slug)view.message=acc.message_model_slug;if(acc.resolved_model_slug)view.resolved=acc.resolved_model_slug;if(acc.provider_response_model)view.provider=acc.provider_response_model;if(acc.reroute)view.reroute=acc.reroute;}

  function beginTurn(meta={}){
    onNavigation();
    if(active&&active.end===null) finish(active,'已被新轮次替代');
    if(active?.reader) void active.reader.cancel().catch(()=>{});
    const t={id:++serial,epoch,conversationId:pageId(),ledgerId:crypto.randomUUID?.()||`${Date.now()}-${serial}-${Math.random().toString(16).slice(2)}`,ledgerState:'unsaved',behaviorLabel:null,wallStarted:meta.wallStarted??Date.now(),started:meta.started??now(),headers:null,firstByte:null,firstText:null,firstAnswer:null,lastAnswer:null,end:null,bytes:0,answerChars:0,firstAnswerChars:0,messages:new Map(),doc:{},patchPath:'',patchOp:null,reader:null,protocolDone:false,parseMisses:0,surface:meta.surface||null,endpoint:meta.endpoint||null,httpMethod:meta.httpMethod||null,client:'web'};
    active=t;view=emptyView('请求中');view.turn=t;view.surface=t.surface;view.endpoint=t.endpoint;if(timer!==null)clearInterval(timer);timer=setInterval(()=>{if(!document.hidden||pipWindow)render();},1000);render();return t;
  }
  function finish(t,status){if(!current(t)||t.end!==null)return;t.end=now();view.status=status;if(timer!==null)clearInterval(timer);timer=null;render();void persist(t,status);}
  function messageMetadata(md){if(!md||typeof md!=='object')return;if(Object.hasOwn(md,'model_slug'))view.message=Probe.requestedModel({model:md.model_slug});if(Object.hasOwn(md,'resolved_model_slug'))view.resolved=Probe.requestedModel({model:md.resolved_model_slug});}
  function acceptConversation(t,id){if(!str(id))return true;if(t.conversationId&&t.conversationId!==id)return false;t.conversationId=id;return true;}
  function inspectMessage(t,m,path=''){if(m?.author?.role!=='assistant')return;messageMetadata(m.metadata);const c=m.content;if(!c||!['text','multimodal_text'].includes(c.content_type)||!Array.isArray(c.parts))return;if(c.parts.some(p=>typeof p==='string'&&p.length>256_000)){t.parseMisses++;return;}const text=c.parts.filter(p=>typeof p==='string').join(''),key=m.id||`anonymous:${path}`,prev=t.messages.get(key),stamp=now(),answer=(!m.channel||m.channel==='final')&&(!m.recipient||m.recipient==='all'),count=charCount(text);if(text.length&&t.firstText===null)t.firstText=stamp;t.messages.set(key,{text,chars:count,answer});if(answer&&text.length&&(!prev||prev.text!==text||!prev.answer)){if(t.firstAnswer===null){t.firstAnswer=stamp;t.firstAnswerChars=count;}t.lastAnswer=stamp;}t.answerChars=Array.from(t.messages.values()).reduce((n,x)=>n+(x.answer?x.chars:0),0);}
  function scan(t,o,path='',depth=0){if(!o||typeof o!=='object'||depth>10)return;if(o.author?.role){inspectMessage(t,o,path);return;}if(o.type==='server_ste_metadata'){if(acceptConversation(t,o.conversation_id))view.ste=str(o.metadata?.model_slug);return;}if(o.conversation_id&&!acceptConversation(t,o.conversation_id))return;for(const[k,v]of Object.entries(o)){if(['metadata','content','author'].includes(k))continue;if(v&&typeof v==='object')scan(t,v,`${path}/${k}`,depth+1);}}
  function pointer(path){if(path==='')return[];if(typeof path!=='string'||!path.startsWith('/'))throw new Error('path');const keys=path.slice(1).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~'));if(keys.some(k=>['__proto__','prototype','constructor'].includes(k)))throw new Error('key');return keys;}
  function patch(t,path,op,value){const keys=pointer(path);if(!keys.length){if(op==='add'||op==='replace')t.doc=value;else if(op==='remove')t.doc={};else throw new Error('root operation');return;}let p=t.doc;for(const k of keys.slice(0,-1)){if(!p||typeof p!=='object'||!Object.hasOwn(p,k))throw new Error('parent');p=p[k];}if(!p||typeof p!=='object')throw new Error('parent');const k=keys.at(-1);if(op==='append'){if(typeof p[k]==='string'&&typeof value==='string')p[k]+=value;else if(Array.isArray(p[k]))p[k].push(...(Array.isArray(value)?value:[value]));else throw new Error('append');}else if(op==='add'){if(Array.isArray(p)){const i=k==='-'?p.length:Number(k);if(!Number.isInteger(i)||i<0||i>p.length)throw new Error('index');p.splice(i,0,value);}else p[k]=value;}else if(op==='replace'){if(!Object.hasOwn(p,k))throw new Error('replace');p[k]=value;}else if(op==='remove'){if(Array.isArray(p))p.splice(Number(k),1);else delete p[k];}else throw new Error('operation');}
  function ingest(t,o,inPath=null,inOp=null){if(!current(t)||!o||typeof o!=='object')return;if(Array.isArray(o)){for(const x of o)ingest(t,x);return;}if(o.conversation_id&&!acceptConversation(t,o.conversation_id))return;if(o.type==='server_ste_metadata'){view.ste=str(o.metadata?.model_slug);return;}if(Object.hasOwn(o,'v')){const path=o.p??inPath??t.patchPath,op=o.o??inOp??t.patchOp;if(op==='patch'&&Array.isArray(o.v)){for(const x of o.v)ingest(t,{...x,p:`${path||''}${x.p||''}`});return;}if(op){t.patchPath=path;t.patchOp=op;try{patch(t,path,op,o.v);scan(t,t.doc);}catch{t.parseMisses++;scan(t,o.v);}return;}scan(t,o.v);}if(o.message)t.doc=o;scan(t,o);}

  async function inspectStream(response,t){
    if(!current(t))return;if(!response.ok)return finish(t,'HTTP '+response.status);if(!response.body)return finish(t,'无响应体');
    const ct=(response.headers.get('content-type')||'').toLowerCase();
    let reader;try{reader=response.body.getReader();t.reader=reader;const dec=new TextDecoder();
      const parser=new Probe.StreamDecoder(o=>{readEvidence(o);ingest(t,o);},{ndjson:/ndjson|jsonl/.test(ct),onDone:()=>{t.protocolDone=true;},onError:()=>{t.parseMisses++;}});
      let json='';
      for(;;){const{value,done}=await reader.read();if(!current(t)||!enabled)break;if(value?.byteLength){if(t.firstByte===null)t.firstByte=now();t.bytes+=value.byteLength;view.status='接收中';}if(t.bytes>8_000_000){t.parseMisses++;finish(t,'观察已达 8 MB 上限；回复继续');break;}const text=dec.decode(value||new Uint8Array(),{stream:!done});
        if(ct.includes('application/json')){json+=text;if(json.length>2_000_000){t.parseMisses++;finish(t,'响应超过观察上限');break;}}
        else parser.feed(text);
        if(parser.stopped){finish(t,'事件超过观察上限');break;}
        if(t.protocolDone||done){if(ct.includes('application/json')){try{const o=JSON.parse(json);readEvidence(o);ingest(t,o);}catch{t.parseMisses++;}}else parser.end();finish(t,t.protocolDone?'完成':'响应结束');break;}}
    }catch(e){finish(t,e?.name==='AbortError'?'已中止':'流读取失败');}finally{if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}t.reader=null;t.doc={};t.messages.clear();if(current(t))render();}}

  async function inspectHistory(response,id,capEpoch,capSerial){if(!response.ok||!((response.headers.get('content-type')||'').includes('application/json')))return;try{const json=await response.clone().json();if(epoch!==capEpoch||serial!==capSerial||active||pageId()!==id)return;if((json.id||json.conversation_id||id)!==id||!json.mapping)return;let node=json.current_node;const seen=new Set();while(node&&!seen.has(node)){seen.add(node);const e=json.mapping[node];if(!e)break;if(e.message?.author?.role==='assistant'){view=emptyView('历史消息；计时需重新发起回复');messageMetadata(e.message.metadata);render();return;}node=e.parent;}}catch{}}

  W.fetch=async function(input,init){
    if(!enabled)return nativeFetch(input,init);
    const url=requestUrl(input),local=url?.origin===location.origin,method=String(init?.method||input?.method||'GET').toUpperCase();
    const capturedEpoch=observerEpoch,capturedNavigation=epoch;
    const knownStream=local&&method==='POST'&&STREAM_RE.test(url.pathname);
    const candidate=local&&/^\/(?:backend-api|api)\//.test(url.pathname)&&['GET','POST'].includes(method);
    const id=local&&method==='GET'?url.pathname.match(HISTORY_RE)?.[1]:null;
    const started=now(),wallStarted=Date.now();
    const payload=candidate?requestPayload(input,init):Promise.resolve(null);
    const response=await nativeFetch(input,init);
    const headersAt=now(),ct=(response.headers.get('content-type')||'').toLowerCase();
    const stream=candidate&&(/text\/event-stream|ndjson|jsonl/.test(ct)||method==='POST'&&ct.includes('application/json')&&/work|codex|conversation|responses|turn/.test(url.pathname));
    if(enabled&&capturedEpoch===observerEpoch&&(knownStream||stream)){
      const copy=response.clone();
      void payload.then(body=>{
        if(!enabled||capturedEpoch!==observerEpoch||capturedNavigation!==epoch){void copy.body?.cancel().catch(()=>{});return;}
        const surface=Probe.surfaceFor(location.href,url.href,body);
        const t=beginTurn({started,wallStarted,surface:surface==='unknown'&&knownStream?'chat':surface,endpoint:url.pathname,httpMethod:method});
        t.network=browserNetwork();t.httpStatus=response.status;t.contentType=ct;
        view.requested=Probe.requestedModel(body);if(str(body?.conversation_id))acceptConversation(t,body.conversation_id);
        t.headers=headersAt;render();void inspectStream(copy,t);
      }).catch(()=>{});
    }else if(id){const capEpoch=epoch,capSerial=serial;void inspectHistory(response,id,capEpoch,capSerial);}
    return response;
  };

  let lastTransport='',transportCount=0,transportWindow=0;
  function observeSocket(obj,url,transport){
    if(!enabled)return;
    const evidence=Probe.extractEvidence(obj),diag={};Probe.inspectShape(obj,diag);
    if(Probe.evidenceState(evidence)==='metadata_unavailable'&&!diag.model_candidates.length)return;
    const signature=JSON.stringify([url,transport,evidence,diag.model_candidates]);if(signature===lastTransport)return;lastTransport=signature;
    if(Date.now()-transportWindow>1000){transportWindow=Date.now();transportCount=0;}if(++transportCount>4)return;
    // Transport events have their own receipt; they must not replace a streaming turn.
    const rec={schema:'chatgpt-model-probe-ledger/v3',probe_version:'1.5.1',id:crypto.randomUUID(),timestamp:new Date().toISOString(),local_day:dayKey(),surface:Probe.surfaceFor(location.href,url,null),endpoint:new URL(url,location.href).pathname,http_method:transport,evidence_state:Probe.evidenceState(evidence),record_kind:'transport_event',diagnostics:diag,network:browserNetwork(),comparison_tag:comparisonTag,probe_session_id:probeSession,probe_elapsed_ms:Date.now()-probeStarted,login_marked_at:loginMarkedAt,login_elapsed_ms:loginMarkedAt?Date.now()-Date.parse(loginMarkedAt):null,...evidence};
    void dbPut(rec).then(refreshToday).catch(()=>{});
    if(!active||active.end!==null){view=emptyView('收到模型事件（非独立完整轮次）');view.surface=rec.surface;view.endpoint=rec.endpoint;readEvidence(obj);render();}
  }
  if(W.WebSocket){const Native=W.WebSocket;W.WebSocket=new Proxy(Native,{construct(Target,args){
    const socket=Reflect.construct(Target,args),u=requestUrl(args[0]);
    if(u&&u.host===location.host)socket.addEventListener('message',e=>{if(!enabled||typeof e.data!=='string'||e.data.length>256_000)return;try{observeSocket(JSON.parse(e.data),u.href,'WS');}catch{}});
    return socket;
  }});}
  if(W.EventSource){const Native=W.EventSource;W.EventSource=new Proxy(Native,{construct(Target,args){
    const source=Reflect.construct(Target,args),u=requestUrl(args[0]);
    if(u&&u.origin===location.origin)for(const name of ['message','server_ste_metadata','model/rerouted','response.completed'])source.addEventListener(name,e=>{if(!enabled||e.data.length>256_000)return;try{const o=JSON.parse(e.data);if(name!=='message'&&!o.type)o.type=name;observeSocket(o,u.href,'EventSource');}catch{}});
    return source;
  }});}
  if(W.XMLHttpRequest){
    const proto=W.XMLHttpRequest.prototype,open=proto.open,send=proto.send,requests=new WeakMap();
    proto.open=function(method,url,...rest){requests.set(this,{method:String(method).toUpperCase(),url:requestUrl(url)});return open.call(this,method,url,...rest);};
    proto.send=function(body){const req=requests.get(this),cap=observerEpoch;
      if(enabled&&req?.url?.origin===location.origin&&/^\/(backend-api|api)\//.test(req.url.pathname)){
        this.addEventListener('load',()=>{if(!enabled||cap!==observerEpoch)return;
          try{const ct=this.getResponseHeader('content-type')||'';
            if(this.responseType==='json')observeSocket(this.response,req.url.href,'XHR');
            else if((this.responseType===''||this.responseType==='text')&&this.responseText.length<=256_000){
              if(ct.includes('application/json'))observeSocket(JSON.parse(this.responseText),req.url.href,'XHR');
              else if(/event-stream|ndjson|jsonl/.test(ct)){const p=new Probe.StreamDecoder(o=>observeSocket(o,req.url.href,'XHR'),{ndjson:/ndjson|jsonl/.test(ct)});p.feed(this.responseText);p.end();}
            }
          }catch{}
        },{once:true});
      }
      return send.call(this,body);
    };
  }
  function toggle(){
    enabled=!enabled;observerEpoch++;
    if(!enabled){if(active&&active.end===null)finish(active,'观察已暂停');void active?.reader?.cancel().catch(()=>{});view.status='观察已暂停';}
    else view.status='等待新请求';
    render();
  }
  async function floatPanel(){
    if(!W.documentPictureInPicture){view.status='当前浏览器不支持独立浮窗';render();return;}
    try{pipWindow=await W.documentPictureInPicture.requestWindow({width:420,height:620});pipWindow.document.body.style.cssText='margin:0;background:#181818';render();pipWindow.addEventListener('pagehide',()=>{pipWindow=null;render();});}
    catch{view.status='独立浮窗未打开';render();}
  }

  function onNavigation(){const path=location.pathname,id=pageId();if(path===currentPath)return;currentPath=path;if(id&&active?.conversationId===id&&pageConversationId===null){pageConversationId=id;render();return;}if(id&&id===pageConversationId)return;pageConversationId=id;if(active&&active.end===null)finish(active,'会话切换');epoch++;if(active?.reader)void active.reader.cancel().catch(()=>{});active=null;if(timer!==null)clearInterval(timer);timer=null;view=emptyView('已切换会话；等待消息数据');render();}
  for(const name of['pushState','replaceState']){const orig=history[name];history[name]=function(...args){const r=orig.apply(this,args);onNavigation();return r;};}
  addEventListener('popstate',onNavigation,true);
  queueMicrotask(async()=>{const id=pageId(),capEpoch=epoch,capSerial=serial;if(!id||active)return;try{const r=await nativeFetch(`/backend-api/conversation/${encodeURIComponent(id)}`,{credentials:'same-origin'});await inspectHistory(r,id,capEpoch,capSerial);}catch{}});

  function pos(left,top,persist=false){if(!panel?.isConnected)return;const x=Math.min(Math.max(0,innerWidth-panel.offsetWidth),Math.max(0,left)),y=Math.min(Math.max(0,innerHeight-panel.offsetHeight),Math.max(0,top));panel.style.left=`${x}px`;panel.style.top=`${y}px`;panel.style.right='auto';panel.style.bottom='auto';if(persist){ui.left=x;ui.top=y;saveUi();}}
  function applyPos(){if(Number.isFinite(ui.left)&&Number.isFinite(ui.top))pos(ui.left,ui.top);else{panel.style.left='auto';panel.style.top='auto';panel.style.right='14px';panel.style.bottom='14px';}}
  function clamp(persist=false){if(panel?.isConnected&&Number.isFinite(ui.left)&&Number.isFinite(ui.top))pos(ui.left,ui.top,persist);}
  function button(label,action,active=false){return`<button type="button" data-probe-action="${action}" style="border:1px solid #555;border-radius:6px;padding:2px 7px;background:${active?'#454545':'#2c2c2c'};color:#f4f4f4;font:inherit;cursor:pointer">${label}</button>`;}
  function installUi(){
    panel.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('[data-probe-action]')||!e.target.closest('[data-probe-drag-handle]')||pipWindow)return;const r=panel.getBoundingClientRect();drag={id:e.pointerId,dx:e.clientX-r.left,dy:e.clientY-r.top};panel.setPointerCapture(e.pointerId);e.preventDefault();});
    panel.addEventListener('pointermove',e=>{if(drag?.id===e.pointerId)pos(e.clientX-drag.dx,e.clientY-drag.dy);});
    const end=e=>{if(drag?.id!==e.pointerId)return;drag=null;const r=panel.getBoundingClientRect();ui.left=r.left;ui.top=r.top;saveUi();};
    panel.addEventListener('pointerup',end);panel.addEventListener('pointercancel',end);
    panel.addEventListener('click',e=>{
      const b=e.target.closest('[data-probe-action]');if(!b)return;const a=b.dataset.probeAction;
      if(a==='collapse'){ui.collapsed=!ui.collapsed;saveUi();return render();}
      if(a==='toggle')return toggle();if(a==='float')return void floatPanel();
      if(a==='login'){loginMarkedAt=new Date().toISOString();render();return;}
      if(a==='context'){const value=prompt('对照标签（账号代号 / 网线或 Wi-Fi / 节点代号）',comparisonTag);if(value!==null){comparisonTag=value.slice(0,60);ui.comparisonTag=comparisonTag;saveUi();render();}return;}
      if(a==='export-json')return void exportToday('json');if(a==='export-csv')return void exportToday('csv');
      if(a==='copy-summary')return void copySummary();
      if(a.startsWith('label-'))return void setLabel(a.slice(6));
      if(a==='clear-ledger'&&confirm('清空探针本地记录？'))void dbClear().then(refreshToday);
    });
  }
  addEventListener('resize',()=>clamp(true),{passive:true});
  function render(){
    const host=pipWindow?.document.body||document.body||document.documentElement;if(!host)return;
    if(!panel){panel=document.createElement('div');panel.id='tm-chatgpt-model-slug-probe';installUi();}
    if(panel.parentNode!==host)host.appendChild(panel);
    panel.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;box-sizing:border-box;padding:10px 12px;background:#202123;color:#f4f4f4;border:1px solid #65676a;border-radius:8px;font:12px/1.5 system-ui,sans-serif;letter-spacing:0;box-shadow:0 4px 18px #0003;pointer-events:auto;overflow:auto;overflow-wrap:anywhere;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px)';
    panel.style.width=ui.collapsed?'260px':'380px';
    if(pipWindow){panel.style.position='relative';panel.style.right='auto';panel.style.bottom='auto';panel.style.width='100%';panel.style.maxWidth='100%';panel.style.maxHeight='100dvh';}else applyPos();
    const t=view.turn,delay=k=>t?.[k]!=null?fmtMs(t[k]-t.started):'—',m=mismatchSnapshot(view),network=browserNetwork();
    const row=(k,v)=>'<div style="display:grid;grid-template-columns:minmax(100px,.8fr) minmax(0,1.2fr);gap:8px;margin:3px 0"><span style="color:#b6b9bf">'+esc(k)+'</span><span>'+esc(v)+'</span></div>';
    const reported=view.reroute?.to_model||view.ste||view.provider||view.resolved||view.message||'未观测到返回模型';
    const header='<div data-probe-drag-handle="1" style="display:flex;align-items:center;gap:8px;touch-action:none;cursor:move;user-select:none"><strong style="flex:1">ChatGPT Probe 1.5.1</strong><label title="启用观察"><input type="checkbox" data-probe-action="toggle" '+(enabled?'checked':'')+'>观察</label><button title="'+(ui.collapsed?'展开':'收起')+'" aria-label="'+(ui.collapsed?'展开':'收起')+'" data-probe-action="collapse" style="width:28px;height:28px">'+(ui.collapsed?'+':'−')+'</button></div>';
    panel.innerHTML=header+'<div style="margin:5px 0;color:'+(enabled?'#80d7b6':'#b6b9bf')+'">'+esc(enabled?reported:'观察已暂停')+'</div>'+row('证据',evidenceState());
    if(ui.collapsed){clamp();return;}
    panel.innerHTML+=row('状态',view.status)+row('入口',view.surface||'unknown')+row('请求模型',view.requested)+row('消息模型',view.message)+row('解析模型',view.resolved)+row('STE 字段',view.ste)+row('响应 model',view.provider)+row('显式改路由',view.reroute?view.reroute.from_model+' → '+view.reroute.to_model:'未观测')+row('endpoint',view.endpoint)
      +row('已收事件',view.diagnostics.events)+row('事件类型',view.diagnostics.event_types.join(', ')||'未观测')+row('其他 model 字段',view.diagnostics.model_candidates.map(x=>x.path+' = '+x.value).join('; ')||'未观测')
      +'<hr style="border:0;border-top:1px solid #555">'+row('响应头',delay('headers'))+row('首段正文',delay('firstAnswer'))+row('观察时长',t?fmtMs((t.end??now())-t.started):'—')
      +row('正文速度',Number.isFinite(rates(t).charsPerSec)?rates(t).charsPerSec.toFixed(1)+' 字符/s':'—')+row('解析缺失',t?.parseMisses??0)
      +row('对照标签',comparisonTag||'未标记')+row('网络类型',network.connection_type)+row('网络质量等级',network.effective_type)+row('网络变化次数',networkRevision)+row('距登录标记',loginMarkedAt?fmtMs(Date.now()-Date.parse(loginMarkedAt)):'未标记')
      +(m.slugMismatch?'<div style="color:#e4bb71">模型字段有差异；原因未确定</div>':'')
      +(t?.parseMisses?'<div style="color:#e4bb71">解析或观察受限：'+t.parseMisses+'</div>':'')
      +'<div style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap">'+button('对照标签','context')+button('标记刚登录','login')+button('独立浮窗','float')+button('JSON','export-json')+button('CSV','export-csv')+button('复制摘要','copy-summary')+button('清空日志','clear-ledger')+'</div>'
      +'<div style="margin-top:6px;color:#b6b9bf">今日请求 '+today.count+' · 事件 '+(today.events||0)+' · 标记异常 '+today.suspicious+'</div>'
      +(t?.ledgerState==='saved'?'<div style="display:flex;gap:5px;margin-top:6px">'+button('正常','label-normal',t.behaviorLabel==='normal')+button('可疑','label-suspicious',t.behaviorLabel==='suspicious')+button('明显漂移','label-drift',t.behaviorLabel==='drift')+'</div>':'')
      +(ledgerError?'<div style="color:#e4bb71">'+esc(ledgerError)+'</div>':'');
    clamp();
  }

  void prune();void refreshToday();
  if(document.documentElement)render();else new MutationObserver((_,o)=>{if(document.documentElement){o.disconnect();render();}}).observe(document,{childList:true,subtree:true});
})();
