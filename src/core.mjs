const hidden = new Set(['content', 'parts', 'text', 'prompt', 'input', 'instructions', 'arguments', 'output']);

export function modelName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value) ? value : null;
}

export function requestedModel(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 8) return null;
  if (modelName(body.model)) return body.model;
  for (const [key, value] of Object.entries(body)) {
    if (hidden.has(key) || key === 'messages') continue;
    if (value && typeof value === 'object') {
      const found = requestedModel(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function surfaceFor(page, endpoint, body) {
  const paths = [page, endpoint].map(value => {
    try { return new URL(value, 'https://chatgpt.com').pathname; } catch { return ''; }
  });
  const hints = [];
  function walk(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [key, value] of Object.entries(o)) {
      if (hidden.has(key) || key === 'messages') continue;
      if (typeof value === 'string' && /^(mode|surface|product|source|kind|feature|agent|work_mode)$/.test(key)) hints.push(value);
      else if (value && typeof value === 'object') walk(value, depth + 1);
    }
  }
  walk(body);
  const raw = [...paths, ...hints].join(' ').toLowerCase();
  if (/(^|[\s/_-])codex($|[\s/_-])/.test(raw)) return 'codex';
  if (/(^|[\s/_-])work($|[\s/_-])|work_mode|deep_research|agent_mode/.test(raw)) return 'work';
  return 'unknown';
}

export function extractEvidence(o, acc = {}, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 14) return acc;
  if (Array.isArray(o)) { for (const value of o) extractEvidence(value, acc, depth + 1); return acc; }
  const put = (key, value) => { const m = modelName(value); if (m) acc[key] = m; };
  if (o.type === 'server_ste_metadata') put('server_ste_model_slug', o.metadata?.model_slug);
  if (o.author?.role === 'assistant') {
    put('message_model_slug', o.metadata?.model_slug);
    put('resolved_model_slug', o.metadata?.resolved_model_slug);
  }
  if (o.object === 'response') put('provider_response_model', o.model);
  if (/^response\.(created|in_progress|completed)$/.test(o.type || '') && o.response) put('provider_response_model', o.response.model);
  if (['model/rerouted', 'model_reroute', 'modelReroute'].includes(o.method || o.type)) {
    const p = o.params || o;
    const from = modelName(p.fromModel || p.from_model), to = modelName(p.toModel || p.to_model);
    if (from && to) acc.reroute = {from_model: from, to_model: to, reason: modelName(p.reason)};
  }
  // Capture explicit metadata replacement patches without retaining conversation bodies.
  if (['add', 'replace'].includes(o.o || o.op) && typeof (o.p || o.path) === 'string') {
    const p = o.p || o.path, value = o.v ?? o.value;
    if (/\/message\/metadata\/model_slug$/.test(p)) put('message_model_slug', value);
    if (/\/message\/metadata\/resolved_model_slug$/.test(p)) put('resolved_model_slug', value);
    if (/\/message\/metadata$/.test(p)) {
      put('message_model_slug', value?.model_slug); put('resolved_model_slug', value?.resolved_model_slug);
    }
  }
  for (const [key, value] of Object.entries(o)) {
    if (hidden.has(key) || key === 'metadata') continue;
    if (value && typeof value === 'object') extractEvidence(value, acc, depth + 1);
  }
  return acc;
}

export function evidenceState(acc) {
  if (acc.reroute) return 'explicit_reroute_event';
  for (const key of ['server_ste_model_slug', 'provider_response_model', 'resolved_model_slug', 'message_model_slug']) if (acc[key]) return key === 'server_ste_model_slug' ? 'server_ste_metadata' : key;
  return acc.requested_model ? 'requested_only' : 'metadata_unavailable';
}

export function inspectShape(o, diag, path = '', depth = 0) {
  if (!o || typeof o !== 'object' || depth > 10) return;
  if (!path) diag.events = (diag.events || 0) + 1;
  diag.event_types ||= []; diag.model_candidates ||= [];
  const event = modelName(o.type || o.method);
  if (event && !diag.event_types.includes(event) && diag.event_types.length < 24) diag.event_types.push(event);
  if (Array.isArray(o)) { for (const value of o.slice(0,64)) inspectShape(value,diag,path+'/*',depth+1); return; }
  for (const [key,value] of Object.entries(o).slice(0,64)) {
    if (hidden.has(key) || !/^[a-zA-Z_][a-zA-Z0-9_]{0,48}$/.test(key)) continue;
    const p=path+'/'+key;
    if (/^(model|model_slug|resolved_model_slug|modelId|model_id|effective_model|actual_model)$/.test(key) && modelName(value) && diag.model_candidates.length < 16 && !diag.model_candidates.some(x=>x.path===p&&x.value===value)) diag.model_candidates.push({path:p,value,semantic_status:'NOT_VERIFIED'});
    if (value && typeof value === 'object') inspectShape(value,diag,p,depth+1);
  }
}

export class StreamDecoder {
  constructor(onObject, {ndjson = false, onDone = () => {}, onError = () => {}, maxBuffer = 256_000} = {}) {
    Object.assign(this, {onObject, ndjson, onDone, onError, maxBuffer});
    this.buffer = ''; this.data = []; this.name = ''; this.skipLF = false; this.stopped = false; this.eventSize = 0;
  }
  parse(raw, name = '') {
    if (raw === '[DONE]') { this.onDone(); return; }
    try {
      const o = JSON.parse(raw);
      if (name && o && typeof o === 'object' && !o.type) o.type = name;
      this.onObject(o);
    } catch { this.onError('invalid_json'); }
  }
  line(line) {
    if (this.ndjson) { if (line.trim()) this.parse(line); return; }
    if (!line) {
      if (this.data.length) this.parse(this.data.join('\n'), this.name);
      this.data = []; this.name = ''; this.eventSize = 0; return;
    }
    if (line.startsWith(':')) return;
    const i = line.indexOf(':'), key = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (key === 'data') {
      this.eventSize += value.length;
      if (this.eventSize > this.maxBuffer) return this.stop();
      this.data.push(value);
    } else if (key === 'event') this.name = value;
  }
  stop() { this.stopped = true; this.buffer = ''; this.data = []; this.onError('buffer_limit'); }
  feed(text) {
    if (this.stopped) return;
    for (const ch of text) {
      if (this.skipLF) { this.skipLF = false; if (ch === '\n') continue; }
      if (ch === '\r' || ch === '\n') { this.line(this.buffer); this.buffer = ''; this.skipLF = ch === '\r'; }
      else this.buffer += ch;
      if (this.stopped) return;
      if (this.buffer.length > this.maxBuffer) return this.stop();
    }
  }
  end() { if (this.stopped) return; if (this.buffer) this.line(this.buffer); this.buffer = ''; if (!this.ndjson) this.line(''); }
}

export function loopbackUrl(value, protocols = ['http:']) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Only a loopback endpoint without credentials is allowed.');
  return url;
}
