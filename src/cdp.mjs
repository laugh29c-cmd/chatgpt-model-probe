import {StringDecoder} from 'node:string_decoder';
import {randomUUID} from 'node:crypto';
import {StreamDecoder, extractEvidence, requestedModel, surfaceFor, evidenceState, loopbackUrl, modelName, inspectShape} from './core.mjs';
import {networkSnapshot, fingerprint} from './network.mjs';

export async function listTargets(cdp) {
  const base=loopbackUrl(cdp);
  const response=await fetch(new URL('/json/list',base),{signal:AbortSignal.timeout(3000),redirect:'error'});
  if(!response.ok)throw Error('CDP HTTP '+response.status);
  const targets=await response.json();
  if(!Array.isArray(targets))throw Error('Invalid CDP target list');
  return targets.filter(t=>['page','webview','worker','service_worker','shared_worker'].includes(t.type)&&t.webSocketDebuggerUrl);
}

export class Observer {
  constructor(target,{onRecord,onStatus,context=()=>({})}) {
    this.target=target;this.onRecord=onRecord;this.onStatus=onStatus;this.context=context;
    this.pending=new Map();this.requests=new Map();this.sockets=new Map();this.seq=0;this.closed=false;
    this.counters={responses:0,events:0,parse_errors:0,body_unavailable:0,limited:0};
  }
  async connect() {
    loopbackUrl(this.target.webSocketDebuggerUrl,['ws:']);
    this.ws=new WebSocket(this.target.webSocketDebuggerUrl);
    this.ws.addEventListener('message',e=>{void this.message(e).catch(()=>this.onStatus('observer_error',this.counters));});
    this.ws.addEventListener('close',()=>this.close('disconnected'));
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.ws.close();reject(Error('CDP connect timeout'));},4000);this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});this.ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP connection failed'));},{once:true});});
    await this.call('Network.enable',{maxTotalBufferSize:8_000_000,maxResourceBufferSize:2_000_000,maxPostDataSize:128_000});
    this.onStatus('observing_renderer_only',this.counters);
  }
  call(method,params={}) {
    if(this.closed)return Promise.reject(Error('Observer closed'));
    const id=++this.seq;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP command timeout: '+method));},4000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});
  }
  close(status='stopped') {
    if(this.closed)return;this.closed=true;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Observer closed'));}
    this.pending.clear();this.requests.clear();this.sockets.clear();
    try{this.ws?.close();}catch{}
    this.onStatus(status,this.counters);
  }
  async publish(r,status) {
    if(this.closed)return;
    const signature=JSON.stringify([r.acc,status]);if(signature===r.signature)return;r.signature=signature;
    const network=await networkSnapshot();if(this.closed)return;
    this.onRecord({id:randomUUID(),schema:'chatgpt-account-route-ledger/v2',probe_version:'1.5.1',probe:'desktop-cdp',record_kind:'request_observation',timestamp:new Date().toISOString(),request_started_at:r.started_at,request_id:r.id,target_id:this.target.id,transport:r.transport,surface:r.surface,endpoint:r.endpoint,http_method:r.method,http_status:r.status??null,content_type:r.ct||null,edge_request_id:r.edge_id||null,remote_peer_id:r.peer_id||null,observed_duration_ms:Date.now()-r.started_ms,status,coverage:r.coverage||'renderer_only',parse_errors:r.parse_errors||0,diagnostics:structuredClone(r.diagnostics),network_at_start:r.network,network_at_end:network,...r.context,...r.acc,evidence_state:evidenceState(r.acc),observed_effective_reasoning:'NOT_AVAILABLE'});
    this.onStatus('observing_renderer_only',this.counters);
  }
  object(r,o) {
    this.counters.events++;inspectShape(o,r.diagnostics);
    const before=JSON.stringify(r.acc);extractEvidence(o,r.acc);
    if(before!==JSON.stringify(r.acc))void this.publish(r,'metadata_received');
  }
  makeRequest(id,url,method,body) {
    let u;try{u=new URL(url);}catch{return null;}
    if(!/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/.test(u.hostname)&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))return null;
    const r={id,endpoint:u.pathname,method,acc:{requested_model:requestedModel(body)},surface:surfaceFor(this.target.url,url,body),started_at:new Date().toISOString(),started_ms:Date.now(),context:this.context(),transport:'HTTP',network:null,bytes:0,parse_errors:0,diagnostics:{events:0,event_types:[],model_candidates:[]}};
    void networkSnapshot().then(n=>{r.network=n;});
    return r;
  }
  async message(event) {
    if(this.closed)return;let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m.id){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);return;}
    const p=m.params||{},id=p.requestId;
    if(m.method==='Network.requestWillBeSent'){
      let body;try{body=JSON.parse((p.request?.postData||'').slice(0,128_000));}catch{}
      const r=this.makeRequest(id,p.request?.url,p.request?.method,body);if(!r)return;
      if(this.requests.size>=64){this.requests.delete(this.requests.keys().next().value);this.counters.limited++;}
      this.requests.set(id,r);
    }else if(m.method==='Network.responseReceived'){
      const r=this.requests.get(id);if(!r)return;
      const h=p.response?.headers||{};
      r.ct=String(h['content-type']||h['Content-Type']||p.response?.mimeType||'').toLowerCase();r.status=p.response?.status;
      if(!/event-stream|application\/json|ndjson|jsonl/.test(r.ct)){this.requests.delete(id);return;}
      this.counters.responses++;r.edge_id=modelName(h['x-request-id']||h['X-Request-Id']||h['cf-ray']);r.peer_id=p.response.remoteIPAddress?fingerprint(p.response.remoteIPAddress):null;
      const stream=/event-stream|ndjson|jsonl/.test(r.ct);
      if(stream){
        r.transport=r.ct.includes('event-stream')?'SSE':'NDJSON';r.decoder=new StringDecoder('utf8');
        r.parser=new StreamDecoder(o=>this.object(r,o),{ndjson:r.transport==='NDJSON',onError:()=>{r.parse_errors++;this.counters.parse_errors++;},onDone:()=>{void this.publish(r,'protocol_done');}});
        try{const result=await this.call('Network.streamResourceContent',{requestId:id});if(this.closed||!this.requests.has(id))return;r.streaming=true;r.coverage='live_stream';if(result.bufferedData)this.feed(r,result.bufferedData);}
        catch{r.coverage='body_after_finish_only';void this.publish(r,'stream_api_unavailable');}
      }
    }else if(m.method==='Network.dataReceived'){
      const r=this.requests.get(id);if(r?.parser&&p.data)this.feed(r,p.data);
    }else if(m.method==='Network.eventSourceMessageReceived'){
      const r=this.requests.get(id);if(!r||r.streaming||!p.data||p.data.length>256_000)return;
      try{const o=JSON.parse(p.data);if(!o.type)o.type=p.eventName;this.object(r,o);}catch{r.parse_errors++;}
    }else if(m.method==='Network.loadingFinished'){
      const r=this.requests.get(id);if(!r)return;
      try{
        if(r.streaming){r.parser.feed(r.decoder.end());r.parser.end();}
        else if(r.ct){
          if(p.encodedDataLength>2_000_000)throw Error('body_size_limit');
          const value=await this.call('Network.getResponseBody',{requestId:id});
          const body=value.base64Encoded?Buffer.from(value.body,'base64').toString('utf8'):value.body;
          if(body.length>2_000_000)throw Error('body_size_limit');
          if(r.parser){r.parser.feed(body);r.parser.end();}
          else if(/ndjson|jsonl/.test(r.ct)){const parser=new StreamDecoder(o=>this.object(r,o),{ndjson:true});parser.feed(body);parser.end();}
          else {try{this.object(r,JSON.parse(body));}catch{r.parse_errors++;this.counters.parse_errors++;}}
        }
        if(r.ct)await this.publish(r,'response_finished');
      }catch{this.counters.body_unavailable++;r.coverage='body_unavailable';await this.publish(r,'body_unavailable');}
      this.requests.delete(id);
    }else if(m.method==='Network.loadingFailed'){
      const r=this.requests.get(id);if(r){await this.publish(r,'network_failed');this.requests.delete(id);}
    }else if(m.method==='Network.webSocketCreated'){
      if(this.sockets.size>=32)this.sockets.delete(this.sockets.keys().next().value);
      const r=this.makeRequest(id,p.url,'WS',null);if(r){r.transport='WebSocket';this.sockets.set(id,r);}
    }else if(m.method==='Network.webSocketClosed'){this.sockets.delete(id);
    }else if(m.method==='Network.webSocketFrameReceived'){
      const r=this.sockets.get(id),data=p.response?.payloadData;if(!r||p.response.opcode!==1||typeof data!=='string'||data.length>256_000)return;
      try{const acc=extractEvidence(JSON.parse(data));if(evidenceState(acc)==='metadata_unavailable')return;
        // A frame is not a complete turn; do not inherit a previous frame's model.
        const frame={...r,acc,signature:null,context:this.context(),started_ms:Date.now(),started_at:new Date().toISOString()};await this.publish(frame,'websocket_metadata_event');
      }catch{this.counters.parse_errors++;}
    }
  }
  feed(r,base64) {
    if(!r.parser||r.parser.stopped)return;
    r.bytes+=Buffer.byteLength(base64,'base64');
    if(r.bytes>8_000_000){r.parser.stop();r.coverage='observation_size_limit';this.counters.limited++;void this.publish(r,'observation_limited');return;}
    r.parser.feed(r.decoder.write(Buffer.from(base64,'base64')));
  }
}
