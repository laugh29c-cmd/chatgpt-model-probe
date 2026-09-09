import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamDecoder,extractEvidence,evidenceState,inspectShape,requestedModel,surfaceFor,loopbackUrl} from '../src/core.mjs';
test('SSE accepts fragmented CRLF, named metadata and multiple data lines',()=>{
  const acc={};let done=0;const parser=new StreamDecoder(o=>extractEvidence(o,acc),{onDone:()=>done++});
  const wire=': comment\r\nevent: server_ste_metadata\r\ndata: {"metadata":\r\ndata: {"model_slug":"gpt-test"}}\r\n\r\ndata: [DONE]\r\n\r\n';
  for(const char of wire)parser.feed(char);parser.end();
  assert.equal(acc.server_ste_model_slug,'gpt-test');assert.equal(done,1);
});
test('Work response envelopes work across JSON-RPC nesting',()=>{
  const acc=extractEvidence({result:{type:'response.completed',response:{object:'response',model:'gpt-work',output:[]}}});
  assert.equal(acc.provider_response_model,'gpt-work');assert.equal(evidenceState(acc),'provider_response_model');
});
test('candidate model fields do not become effective evidence',()=>{
  const payload={params:{turn:{model:'gpt-work'}},input:{model:'secret'},content:{model:'secret2'}},diag={};
  inspectShape(payload,diag);assert.equal(diag.model_candidates.length,1);assert.equal(diag.model_candidates[0].path,'/params/turn/model');
  assert.equal(evidenceState(extractEvidence(payload)),'metadata_unavailable');assert.equal(JSON.stringify(diag).includes('secret'),false);
});
test('plain assistant prose cannot spoof a reroute',()=>{
  assert.equal(evidenceState(extractEvidence({content:'model rerouted: gpt-a -> gpt-b',text:'gpt-b'})),'metadata_unavailable');
  const acc=extractEvidence({method:'model/rerouted',params:{fromModel:'gpt-a',toModel:'gpt-b',reason:'quota'}});
  assert.equal(acc.reroute.to_model,'gpt-b');assert.equal(evidenceState(acc),'explicit_reroute_event');
});
test('NDJSON parses fragments and retains final line',()=>{
  const out=[];const parser=new StreamDecoder(o=>out.push(o),{ndjson:true});parser.feed('{"a":');parser.feed('1}\n{"b":2}');parser.end();assert.deepEqual(out,[{a:1},{b:2}]);
});
test('parser limits unterminated and multiline events',()=>{
  let errors=0;const p=new StreamDecoder(()=>assert.fail(),{maxBuffer:20,onError:()=>errors++});p.feed('x'.repeat(21));assert.equal(p.stopped,true);assert.equal(p.buffer.length,0);assert.equal(errors,1);
  const q=new StreamDecoder(()=>assert.fail(),{maxBuffer:20,onError:()=>{}});q.feed('data: 1234567890\ndata: 1234567890\ndata: 1\n');assert.equal(q.stopped,true);
});
test('request model, surface and explicit patch fields',()=>{
  assert.equal(requestedModel({messages:[{model:'wrong'}],config:{model:'gpt-right'}}),'gpt-right');
  assert.equal(surfaceFor('/c/id','/backend-api/conversation',{mode:'work'}),'work');
  assert.equal(surfaceFor('/c/id','/backend-api/conversation',null),'unknown');
  assert.equal(extractEvidence({p:'/message/metadata/model_slug',o:'replace',v:'gpt-patch'}).message_model_slug,'gpt-patch');
});
test('CDP rejects remote endpoints and credentials',()=>{
  assert.equal(loopbackUrl('http://127.0.0.1:9222').hostname,'127.0.0.1');
  for(const url of ['http://192.168.1.1:9222','http://example.com','http://user:password@localhost'])assert.throws(()=>loopbackUrl(url));
});
