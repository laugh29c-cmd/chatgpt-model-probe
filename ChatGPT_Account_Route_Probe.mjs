#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Observer,listTargets} from './src/cdp.mjs';
import {loopbackUrl} from './src/core.mjs';
import {networkSnapshot} from './src/network.mjs';

const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
if(args.includes('--help')){console.log('node ChatGPT_Account_Route_Probe.mjs [--cdp http://127.0.0.1:9222] [--port 0] [--data-dir PATH]\nSelect one authorized target in the panel. Ctrl-C stops everything. Node 22+ required.');process.exit(0);}
const cdp=loopbackUrl(arg('--cdp')||process.env.CHATGPT_ROUTE_CDP||'http://127.0.0.1:9222').href;
const port=Number(arg('--port')||0);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid --port');
const dataDir=path.resolve(arg('--data-dir')||fileURLToPath(new URL('./data/',import.meta.url)));
fs.mkdirSync(dataDir,{recursive:true});
const ledger=path.join(dataDir,'account-route-ledger.jsonl');
const token=randomUUID(),session=randomUUID(),started=Date.now();
let observer=null,status='not_connected',counters={},login=null,tags={network_tag:'',account_tag:''},records=[],writes=0,rateStart=Date.now(),rateCount=0,dropped=0;
let ledgerBytes=0;
if(fs.existsSync(ledger)){
  ledgerBytes=fs.statSync(ledger).size;
  if(ledgerBytes<=2_000_000){records=fs.readFileSync(ledger,'utf8').split(/\r?\n/).filter(Boolean).flatMap(line=>{try{const r=JSON.parse(line);return r.schema==='chatgpt-account-route-ledger/v2'?[r]:[];}catch{return[];}}).slice(-1000);}
  else status='existing_ledger_over_limit';
}
const clients=new Set();
function push(){for(const res of clients)if(!res.writableNeedDrain)res.write('data: '+JSON.stringify(snapshot())+'\n\n');}
function snapshot(){return {version:'1.5.1',status,cdp,counters,dropped,login,tags,probe_session_id:session,uptime_ms:Date.now()-started,records:records.slice(-100),csrf:token};}
function record(rec){
  if(Date.now()-rateStart>1000){rateStart=Date.now();rateCount=0;}
  if(++rateCount>10){dropped++;return;}
  records.push(rec);if(records.length>1000)records.shift();
  try{const line=JSON.stringify(rec)+'\n';ledgerBytes+=Buffer.byteLength(line);if(ledgerBytes>2_000_000){const recent=records.slice(-100).map(r=>JSON.stringify(r)).join('\n')+'\n';fs.writeFileSync(ledger,recent);ledgerBytes=Buffer.byteLength(recent);}else fs.appendFileSync(ledger,line);}
  catch{status='ledger_write_failed';}
  schedulePush();
}
let pushTimer=null;
function schedulePush(){if(pushTimer)return;pushTimer=setTimeout(()=>{pushTimer=null;push();},1000);}
function onStatus(s,c){if(status!=='ledger_write_failed')status=s;counters={...c};schedulePush();}
function context(){return {...tags,probe_session_id:session,probe_elapsed_ms:Date.now()-started,login_marked_at:login,login_elapsed_ms:login?Date.now()-Date.parse(login):null};}
function stop(){observer?.close('paused');observer=null;status='paused';}
let origin;
const server=http.createServer(async(req,res)=>{
  const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin))return json(403,{error:'origin_rejected'});
  const url=new URL(req.url,origin);
  try{
    if(req.method==='GET'&&url.pathname==='/'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",'x-content-type-options':'nosniff'});
      return res.end(fs.readFileSync(new URL('./src/panel.html',import.meta.url)));
    }
    if(req.method==='GET'&&url.pathname==='/api/state')return json(200,snapshot());
    if(req.method==='GET'&&url.pathname==='/api/events'){
      if(clients.size>=4)return json(429,{error:'viewer_limit'});
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'});clients.add(res);res.write('data: '+JSON.stringify(snapshot())+'\n\n');req.on('close',()=>clients.delete(res));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/targets'){
      try{return json(200,(await listTargets(cdp)).map(t=>({id:t.id,type:t.type,url:t.url,title:t.title||''})));}
      catch{return json(503,{error:'CDP_NOT_AVAILABLE'});}
    }
    if(req.method==='GET'&&url.pathname==='/api/network')return json(200,await networkSnapshot());
    if(req.method==='GET'&&url.pathname==='/api/export'){
      res.writeHead(200,{'content-type':'application/json','content-disposition':'attachment; filename="chatgpt-route-probe.json"','cache-control':'no-store'});return res.end(JSON.stringify({schema:'chatgpt-probe-export/v1',exported_at:new Date().toISOString(),probe_session_id:session,records},null,2));
    }
    if(req.method==='POST'&&url.pathname==='/api/control'){
      if(req.headers['x-probe-token']!==token||req.headers['content-type']!=='application/json')return json(403,{error:'token_required'});
      let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return json(413,{error:'body_limit'});}
      const p=JSON.parse(body);
      if(p.action==='pause')stop();
      else if(p.action==='connect'){
        const target=(await listTargets(cdp)).find(t=>t.id===p.target_id);if(!target)return json(404,{error:'target_not_found'});
        stop();observer=new Observer(target,{onRecord:record,onStatus,context});
        try{await observer.connect();}catch{observer.close('connect_failed');throw Error('connect_failed');}
      }else if(p.action==='login'){login=p.clear===true?null:new Date().toISOString();}
      else if(p.action==='tags'){
        for(const key of ['network_tag','account_tag'])if(typeof p[key]==='string')tags[key]=p[key].replace(/[\r\n\t]/g,' ').slice(0,40);
      }else if(p.action==='label'){
        const rec=records.find(r=>r.id===p.id);if(!rec||!['normal','suspicious','drift'].includes(p.label))return json(400,{error:'invalid_label'});
        rec.behavior_label=p.label;
        fs.writeFileSync(ledger,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
      }else return json(400,{error:'unknown_action'});
      push();return json(200,{ok:true});
    }
    return json(404,{error:'not_found'});
  }catch{if(!res.headersSent)json(500,{error:'operation_failed'});else res.end();}
});
server.on('error',error=>{console.error(error.code||error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;console.log('ChatGPT Route Probe 1.5.1\nPanel: '+origin+'\nLedger: '+ledger+'\nNo target attached. Select a target in the panel. Ctrl-C stops everything.');});
function shutdown(){stop();clearTimeout(pushTimer);for(const res of clients)res.end();server.close();server.closeAllConnections();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
