// ==UserScript==
// @name         ChatGPT Model Slug Probe
// @namespace    chatgpt-model-probe
// @version      1.3.1
// @description  Observe ChatGPT request/message/resolved/STE model metadata and client-side timing from network traffic only.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const W = window;
  if (W.__CHATGPT_MODEL_PROBE_131__) return;
  W.__CHATGPT_MODEL_PROBE_131__ = true;

  const nativeFetch = W.fetch.bind(W);
  const CONV_RE = /^\/c\/([0-9a-f-]{20,})(?:\/|$)/i;
  const HISTORY_RE = /^\/backend-api\/(?:f\/)?conversation\/([0-9a-f-]{20,})\/?$/i;
  const STREAM_RE = /^\/backend-api\/(?:f\/)?conversation\/?$/i;
  const UI_KEY = 'chatgpt-model-probe-ui-v131';
  const now = () => performance.now();
  const str = v => typeof v === 'string' && v.trim() ? v.trim() : null;
  const pageId = () => location.pathname.match(CONV_RE)?.[1] || null;
  const chars = text => Array.from(text).length;

  let epoch = 0;
  let serial = 0;
  let active = null;
  let timer = null;
  let panel = null;
  let drag = null;
  let currentPath = location.pathname;
  let pageConversationId = pageId();
  let ui = loadUi();
  let view = emptyView('等待新回复');

  function emptyView(status) {
    return { requested: null, message: null, resolved: null, ste: null, status, turn: null };
  }

  function current(turn) {
    return active === turn && turn.epoch === epoch;
  }

  function loadUi() {
    try {
      const v = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
      return {
        left: Number.isFinite(v.left) ? v.left : null,
        top: Number.isFinite(v.top) ? v.top : null,
        collapsed: v.collapsed === true,
      };
    } catch {
      return { left: null, top: null, collapsed: false };
    }
  }

  function saveUi() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(ui));
    } catch {}
  }

  function requestUrl(input) {
    try {
      return new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
        location.href,
      );
    } catch {
      return null;
    }
  }

  async function requestPayload(input, init) {
    try {
      let body;
      if (init?.body != null) body = init.body;
      else if (input instanceof Request) return JSON.parse(await input.clone().text());
      if (typeof body === 'string') return JSON.parse(body);
      if (body instanceof Blob) return JSON.parse(await body.text());
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return JSON.parse(new TextDecoder().decode(body));
      }
    } catch {}
    return null;
  }

  function beginTurn() {
    onNavigation();
    if (active?.reader) void active.reader.cancel().catch(() => {});

    const turn = {
      id: ++serial,
      epoch,
      conversationId: pageId(),
      started: now(),
      headers: null,
      firstByte: null,
      firstText: null,
      firstAnswer: null,
      lastAnswer: null,
      end: null,
      bytes: 0,
      answerChars: 0,
      firstAnswerChars: 0,
      messages: new Map(),
      doc: {},
      patchPath: '',
      patchOp: null,
      reader: null,
      protocolDone: false,
      parseMisses: 0,
    };

    active = turn;
    view = emptyView('请求中');
    view.turn = turn;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(render, 250);
    render();
    return turn;
  }

  function finish(turn, status) {
    if (!current(turn) || turn.end !== null) return;
    turn.end = now();
    view.status = status;
    if (timer !== null) clearInterval(timer);
    timer = null;
    render();
  }

  function messageMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return;
    if (Object.hasOwn(metadata, 'model_slug')) view.message = str(metadata.model_slug);
    if (Object.hasOwn(metadata, 'resolved_model_slug')) view.resolved = str(metadata.resolved_model_slug);
  }

  function acceptConversation(turn, id) {
    if (!str(id)) return true;
    if (turn.conversationId && turn.conversationId !== id) return false;
    turn.conversationId = id;
    return true;
  }

  function inspectMessage(turn, message, path = '') {
    if (message?.author?.role !== 'assistant') return;
    messageMetadata(message.metadata);

    const content = message.content;
    if (!content || !['text', 'multimodal_text'].includes(content.content_type) || !Array.isArray(content.parts)) return;

    const text = content.parts.filter(p => typeof p === 'string').join('');
    const key = message.id || `anonymous:${path}`;
    const previous = turn.messages.get(key);
    const stamp = now();
    const answer = (!message.channel || message.channel === 'final') && (!message.recipient || message.recipient === 'all');
    const count = chars(text);

    if (text.length && turn.firstText === null) turn.firstText = stamp;
    turn.messages.set(key, { text, chars: count, answer });

    if (answer && text.length && (!previous || previous.text !== text || !previous.answer)) {
      if (turn.firstAnswer === null) {
        turn.firstAnswer = stamp;
        turn.firstAnswerChars = count;
      }
      turn.lastAnswer = stamp;
    }

    turn.answerChars = Array.from(turn.messages.values()).reduce(
      (total, item) => total + (item.answer ? item.chars : 0),
      0,
    );
  }

  function scan(turn, object, path = '', depth = 0) {
    if (!object || typeof object !== 'object' || depth > 10) return;
    if (object.author?.role) {
      inspectMessage(turn, object, path);
      return;
    }
    if (object.type === 'server_ste_metadata') {
      if (acceptConversation(turn, object.conversation_id)) {
        view.ste = str(object.metadata?.model_slug);
      }
      return;
    }
    if (object.conversation_id && !acceptConversation(turn, object.conversation_id)) return;

    for (const [key, value] of Object.entries(object)) {
      if (['metadata', 'content', 'author'].includes(key)) continue;
      if (value && typeof value === 'object') scan(turn, value, `${path}/${key}`, depth + 1);
    }
  }

  function pointer(path) {
    if (path === '') return [];
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('path');
    const keys = path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('key');
    return keys;
  }

  function patch(turn, path, op, value) {
    const keys = pointer(path);
    if (!keys.length) {
      if (op === 'add' || op === 'replace') turn.doc = value;
      else if (op === 'remove') turn.doc = {};
      else throw new Error('root operation');
      return;
    }

    let parent = turn.doc;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('parent');
      parent = parent[key];
    }
    if (!parent || typeof parent !== 'object') throw new Error('parent');
    const key = keys.at(-1);

    if (op === 'append') {
      if (typeof parent[key] === 'string' && typeof value === 'string') parent[key] += value;
      else if (Array.isArray(parent[key])) parent[key].push(...(Array.isArray(value) ? value : [value]));
      else throw new Error('append');
    } else if (op === 'add') {
      if (Array.isArray(parent)) {
        const index = key === '-' ? parent.length : Number(key);
        if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error('index');
        parent.splice(index, 0, value);
      } else parent[key] = value;
    } else if (op === 'replace') {
      if (!Object.hasOwn(parent, key)) throw new Error('replace');
      parent[key] = value;
    } else if (op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else throw new Error('operation');
  }

  function ingest(turn, object, inheritedPath = null, inheritedOperation = null) {
    if (!current(turn) || !object || typeof object !== 'object') return;
    if (Array.isArray(object)) {
      for (const item of object) ingest(turn, item);
      return;
    }
    if (object.conversation_id && !acceptConversation(turn, object.conversation_id)) return;
    if (object.type === 'server_ste_metadata') {
      view.ste = str(object.metadata?.model_slug);
      return;
    }

    if (Object.hasOwn(object, 'v')) {
      const path = object.p ?? inheritedPath ?? turn.patchPath;
      const operation = object.o ?? inheritedOperation ?? turn.patchOp;

      if (operation === 'patch' && Array.isArray(object.v)) {
        for (const item of object.v) {
          ingest(turn, { ...item, p: `${path || ''}${item.p || ''}` });
        }
        return;
      }

      if (operation) {
        turn.patchPath = path;
        turn.patchOp = operation;
        try {
          patch(turn, path, operation, object.v);
          scan(turn, turn.doc);
        } catch {
          turn.parseMisses++;
          scan(turn, object.v);
        }
        return;
      }
      scan(turn, object.v);
    }

    if (object.message) turn.doc = object;
    scan(turn, object);
  }

  async function inspectStream(response, turn) {
    if (!current(turn)) return;
    if (!response.ok) return finish(turn, `HTTP ${response.status}`);
    if (!((response.headers.get('content-type') || '').includes('text/event-stream'))) return finish(turn, '非 SSE 响应，未测输出');
    if (!response.body) return finish(turn, '无响应体');

    let reader;
    try {
      reader = response.clone().body.getReader();
      turn.reader = reader;
      const decoder = new TextDecoder();
      let lineBuffer = '';
      let dataLines = [];
      let eventName = '';
      let skipLF = false;

      function consumeEvent() {
        const data = dataLines.join('\n');
        dataLines = [];
        const name = eventName;
        eventName = '';
        if (!data) return;
        if (data === '[DONE]') {
          turn.protocolDone = true;
          finish(turn, '完成');
          return;
        }
        try {
          const object = JSON.parse(data);
          if (name === 'server_ste_metadata' && object && typeof object === 'object' && !object.type) object.type = name;
          ingest(turn, object);
        } catch {
          turn.parseMisses++;
        }
      }

      function consumeLine(value) {
        if (!value) return consumeEvent();
        if (value.startsWith(':')) return;
        const colon = value.indexOf(':');
        const key = colon < 0 ? value : value.slice(0, colon);
        let fieldValue = colon < 0 ? '' : value.slice(colon + 1);
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
        if (key === 'data') dataLines.push(fieldValue);
        else if (key === 'event') eventName = fieldValue;
      }

      function feed(text) {
        for (const char of text) {
          if (skipLF) {
            skipLF = false;
            if (char === '\n') continue;
          }
          if (char === '\r' || char === '\n') {
            consumeLine(lineBuffer);
            lineBuffer = '';
            skipLF = char === '\r';
          } else lineBuffer += char;
        }
      }

      for (;;) {
        const { value, done } = await reader.read();
        if (!current(turn)) break;
        if (value?.byteLength) {
          if (turn.firstByte === null) turn.firstByte = now();
          turn.bytes += value.byteLength;
          if (turn.end === null) view.status = '接收中';
        }
        feed(decoder.decode(value || new Uint8Array(), { stream: !done }));
        if (turn.protocolDone || done) {
          if (done && !turn.protocolDone) {
            if (lineBuffer) consumeLine(lineBuffer);
            if (dataLines.length) consumeEvent();
            finish(turn, '流已结束（未见 DONE）');
          }
          break;
        }
      }
    } catch (error) {
      finish(turn, error?.name === 'AbortError' ? '已中止' : '流读取失败');
    } finally {
      if (reader) {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch {}
      }
      turn.reader = null;
      turn.doc = {};
      turn.messages.clear();
      if (current(turn)) render();
    }
  }

  async function inspectHistory(response, id, capturedEpoch, capturedSerial) {
    if (!response.ok || !((response.headers.get('content-type') || '').includes('application/json'))) return;
    try {
      const json = await response.clone().json();
      if (epoch !== capturedEpoch || serial !== capturedSerial || active || pageId() !== id) return;
      if ((json.id || json.conversation_id || id) !== id || !json.mapping) return;

      let node = json.current_node;
      const seen = new Set();
      while (node && !seen.has(node)) {
        seen.add(node);
        const entry = json.mapping[node];
        if (!entry) break;
        if (entry.message?.author?.role === 'assistant') {
          view = emptyView('历史消息；计时需重新发起回复');
          messageMetadata(entry.message.metadata);
          render();
          return;
        }
        node = entry.parent;
      }
    } catch {}
  }

  W.fetch = async function patchedFetch(input, init) {
    const url = requestUrl(input);
    const local = url?.origin === location.origin;
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const isStream = local && method === 'POST' && STREAM_RE.test(url.pathname);
    const id = local && method === 'GET' ? url.pathname.match(HISTORY_RE)?.[1] : null;
    let turn = null;

    if (isStream) {
      const payload = requestPayload(input, init);
      turn = beginTurn();
      void payload.then(body => {
        if (!current(turn)) return;
        view.requested = str(body?.model);
        if (str(body?.conversation_id)) acceptConversation(turn, body.conversation_id);
        render();
      });
    }

    const capturedEpoch = epoch;
    const capturedSerial = serial;
    let response;
    try {
      response = await nativeFetch(input, init);
    } catch (error) {
      if (turn) finish(turn, error?.name === 'AbortError' ? '已中止' : '请求失败');
      throw error;
    }

    if (turn && current(turn)) {
      turn.headers = now();
      void inspectStream(response, turn);
    } else if (id) {
      void inspectHistory(response, id, capturedEpoch, capturedSerial);
    }
    return response;
  };

  function onNavigation() {
    const path = location.pathname;
    const id = pageId();
    if (path === currentPath) return;
    currentPath = path;

    if (id && active?.conversationId === id && pageConversationId === null) {
      pageConversationId = id;
      render();
      return;
    }
    if (id && id === pageConversationId) return;

    pageConversationId = id;
    epoch++;
    if (active?.reader) void active.reader.cancel().catch(() => {});
    active = null;
    if (timer !== null) clearInterval(timer);
    timer = null;
    view = emptyView('已切换会话；等待消息数据');
    render();
  }

  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      onNavigation();
      return result;
    };
  }
  addEventListener('popstate', onNavigation, true);

  queueMicrotask(async () => {
    const id = pageId();
    const capturedEpoch = epoch;
    const capturedSerial = serial;
    if (!id || active) return;
    try {
      const response = await nativeFetch(`/backend-api/conversation/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      await inspectHistory(response, id, capturedEpoch, capturedSerial);
    } catch {}
  });

  function setPosition(left, top, persist = false) {
    if (!panel?.isConnected) return;
    const maxLeft = Math.max(0, innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, innerHeight - panel.offsetHeight);
    const x = Math.min(maxLeft, Math.max(0, left));
    const y = Math.min(maxTop, Math.max(0, top));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    if (persist) {
      ui.left = x;
      ui.top = y;
      saveUi();
    }
  }

  function applyPosition() {
    if (Number.isFinite(ui.left) && Number.isFinite(ui.top)) setPosition(ui.left, ui.top);
    else {
      panel.style.left = 'auto';
      panel.style.top = 'auto';
      panel.style.right = '14px';
      panel.style.bottom = '14px';
    }
  }

  function clamp(persist = false) {
    if (Number.isFinite(ui.left) && Number.isFinite(ui.top)) setPosition(ui.left, ui.top, persist);
  }

  function installPanelInteractions() {
    if (!panel || panel.dataset.interactions === '1') return;
    panel.dataset.interactions = '1';

    panel.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (event.target.closest('[data-collapse]')) return;
      const handle = event.target.closest('[data-drag]');
      if (!handle || !panel.contains(handle)) return;
      const rect = panel.getBoundingClientRect();
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    panel.addEventListener('pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      setPosition(event.clientX - drag.dx, event.clientY - drag.dy);
    });

    const endDrag = event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      const rect = panel.getBoundingClientRect();
      ui.left = rect.left;
      ui.top = rect.top;
      saveUi();
      try { panel.releasePointerCapture?.(event.pointerId); } catch {}
    };
    panel.addEventListener('pointerup', endDrag);
    panel.addEventListener('pointercancel', endDrag);

    panel.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('[data-collapse]');
      if (!button || !panel.contains(button)) return;
      ui.collapsed = !ui.collapsed;
      saveUi();
      render();
    });
  }

  addEventListener('resize', () => clamp(true), { passive: true });

  const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const formatMs = value => value == null || !Number.isFinite(value) || value < 0
    ? '—'
    : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;

  function render() {
    if (!panel?.isConnected) {
      const host = document.body || document.documentElement;
      if (!host) return;
      panel = document.createElement('div');
      panel.id = 'tm-chatgpt-model-slug-probe';
      panel.style.cssText = [
        'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483647',
        'width:390px', 'max-width:calc(100vw - 28px)', 'box-sizing:border-box',
        'padding:11px 13px', 'background:rgba(20,20,20,.93)', 'color:#f4f4f4',
        'border:1px solid #555', 'border-radius:10px',
        'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
        'box-shadow:0 6px 24px #0004', 'pointer-events:auto', 'overflow-wrap:anywhere',
      ].join(';');
      host.appendChild(panel);
      installPanelInteractions();
      applyPosition();
    }

    const turn = view.turn;
    const delay = field => turn?.[field] != null ? formatMs(turn[field] - turn.started) : '—';
    const reported = [view.message, view.resolved, view.ste].filter(Boolean);
    const auto = /^(?:auto|router)(?:[-_].*)?$/i.test(view.requested || '');
    const values = (auto ? reported : [view.requested, ...reported]).filter(Boolean);
    const different = new Set(values.map(v => v.toLowerCase())).size > 1;
    panel.style.borderColor = different ? '#e6b85c' : '#555';

    const span = turn && turn.lastAnswer !== null && turn.firstAnswer !== null ? turn.lastAnswer - turn.firstAnswer : 0;
    const rate = turn && span >= 100 && turn.answerChars > turn.firstAnswerChars
      ? `${((turn.answerChars - turn.firstAnswerChars) / (span / 1000)).toFixed(1)} 字符/s`
      : '—';
    const wireSeconds = turn?.firstByte != null ? (((turn.end ?? now()) - turn.firstByte) / 1000) : 0;
    const wireRate = wireSeconds >= 0.1 ? `${(turn.bytes / 1024 / wireSeconds).toFixed(1)} KiB/s` : '—';
    const row = (label, value) => `<div style="display:grid;grid-template-columns:190px minmax(0,1fr);gap:8px"><span style="opacity:.7">${esc(label)}</span><span>${esc(value)}</span></div>`;

    const header = `<div data-drag="1" style="display:flex;align-items:center;justify-content:space-between;gap:12px;${ui.collapsed ? '' : 'margin-bottom:6px;'}cursor:move;user-select:none;touch-action:none"><span style="font-weight:700;min-width:0">ChatGPT metadata · v1.3.1</span><button type="button" data-collapse="1" style="flex:0 0 auto;border:1px solid #555;border-radius:6px;padding:1px 7px;background:#2c2c2c;color:#f4f4f4;font:inherit;cursor:pointer">${ui.collapsed ? '展开' : '收起'}</button></div>`;

    panel.style.width = ui.collapsed ? '280px' : '390px';
    if (ui.collapsed) {
      panel.innerHTML = header;
      clamp();
      return;
    }

    panel.innerHTML = header
      + (different ? '<div style="color:#e6b85c;margin-bottom:5px">字段有差异（可能是别名/路由，不能据此判定降级）</div>' : '')
      + row('requested (body.model)', view.requested)
      + row('message.model_slug', view.message)
      + row('resolved_model_slug', view.resolved)
      + row('server STE model_slug', view.ste)
      + (turn && !reported.length ? `<div style="color:#e6b85c;margin-top:4px">${turn.end === null ? '本轮尚未收到型号字段' : '本轮未收到型号字段：无法判断模型'}</div>` : '')
      + '<div style="border-top:1px solid #444;margin:7px 0"></div>'
      + row('响应头到达', delay('headers'))
      + row('首数据块（非 TTFT）', delay('firstByte'))
      + row('首段文本（含可见思考）', delay('firstText'))
      + row('首段正文（TTFT 近似）', delay('firstAnswer'))
      + row('本轮耗时', turn ? formatMs((turn.end ?? now()) - turn.started) : '—')
      + row('正文速度（近似）', rate)
      + row('已识别正文字符', turn?.firstAnswer != null ? turn.answerChars : '—')
      + row('SSE 数据速率（含协议）', wireRate)
      + `<div style="opacity:.65;margin-top:7px">${esc(view.status)}${turn?.parseMisses ? ' · 存在未解析事件，文本统计可能不完整' : ''}</div>`
      + '<div style="opacity:.5;font-size:11px;margin-top:3px">客户端收包计时；首数据不是首 token。正文按已识别文本统计，不是 tokens/s；单批输出不估速。网络、排队、缓冲与负载都会影响速度。</div>';
    clamp();
  }

  if (document.documentElement) render();
  else new MutationObserver((_, observer) => {
    if (document.documentElement) {
      observer.disconnect();
      render();
    }
  }).observe(document, { childList: true, subtree: true });
})();
