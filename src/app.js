(() => {
const C = Core;
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt$ = (v) => '$' + (v || 0).toFixed(v >= 10 ? 2 : 3);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const S = {
  key: null, cfg: null, chats: [], chat: null, models: [], usage: [], projects: [], project: localStorage.getItem('apichat.project') || '',
  busy: false, abort: null, atts: [], cards: {}, live: null, status: '', bridge: null, bridgeAt: 0, folders: [], screen: null, turn: 0,
};

// ---------- storage (IndexedDB, values encrypted with the password key) ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('apichat-html', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  raw(k) { return new Promise((res, rej) => { const t = DB.db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); },
  rawPut(k, v) { return new Promise((res, rej) => { const t = DB.db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); },
  del(k) { return new Promise((res, rej) => { const t = DB.db.transaction('kv', 'readwrite').objectStore('kv').delete(k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); },
  keys() { return new Promise((res, rej) => { const t = DB.db.transaction('kv').objectStore('kv').getAllKeys(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); },
  async get(k, dflt) { const box = await DB.raw(k); if (!box) return dflt; try { return await C.decrypt(S.key, box); } catch (e) { return dflt; } },
  async put(k, v) { await DB.rawPut(k, await C.encrypt(S.key, v)); },
  async clear() { for (const k of await DB.keys()) await DB.del(k); },
};

// ---------- API ----------
const API = {
  headers() {
    return { 'content-type': 'application/json', 'anthropic-version': S.cfg.api_version || '2023-06-01', 'x-api-key': S.cfg.api_key, 'anthropic-dangerous-direct-browser-access': 'true' };
  },
  base() { return (S.cfg.api_base || 'https://api.anthropic.com').replace(/\/+$/, ''); },
  async readErr(r) {
    let body = {}; try { body = await r.json(); } catch (e) {}
    const e = new Error((body.error && body.error.message) || ('HTTP ' + r.status)); e.status = r.status; e.type = body.error && body.error.type; return e;
  },
  async stream(req, fn, signal) {
    let last = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) { await sleep((1 << (attempt - 1)) * 2000); if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError'); }
      let r;
      try { r = await fetch(API.base() + '/v1/messages', { method: 'POST', headers: Object.assign(API.headers(), { accept: 'text/event-stream' }), body: JSON.stringify(req), signal }); }
      catch (e) { if (e.name === 'AbortError') throw e; last = e; continue; }
      if (r.status !== 200) { const e = await API.readErr(r); if (e.status === 429 || e.status === 529 || e.status >= 500) { last = e; continue; } throw e; }
      const p = C.streamParser(fn);
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let out;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const err = p.feed(dec.decode(value, { stream: true }));
        if (err) { reader.cancel(); break; }
      }
      out = p.end();
      if (out.error) { if (!out.started && (out.error.status === 0 || out.error.status === undefined) && attempt < 3) { last = out.error; continue; } throw out.error; }
      return out.result;
    }
    throw last || new Error('request failed');
  },
  async models() {
    const r = await fetch(API.base() + '/v1/models?limit=100', { headers: API.headers() });
    if (!r.ok) throw await API.readErr(r);
    const b = await r.json();
    return (b.data || []).map(d => ({ id: d.id, display_name: d.display_name }));
  },
};

// ---------- bridge (APIChat on this PC) ----------
const Bridge = {
  url() { return (S.cfg.bridge_url || '').replace(/\/+$/, ''); },
  headers() { return { 'content-type': 'application/json', 'x-bridge-key': S.cfg.bridge_key || '' }; },
  async info(force) {
    if (!S.cfg.bridge || !Bridge.url()) { S.bridge = null; return null; }
    if (!force && S.bridge && Date.now() - S.bridgeAt < 60000) return S.bridge;
    if (!force && !S.bridge && Date.now() - S.bridgeAt < 15000) return null;
    S.bridgeAt = Date.now();
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 3000);
      const r = await fetch(Bridge.url() + '/bridge/info', { headers: Bridge.headers(), signal: ctl.signal });
      if (!r.ok) { const e = await API.readErr(r); S.bridge = null; S.bridgeErr = e.message; }
      else { S.bridge = await r.json(); S.bridgeErr = ''; }
    } catch (e) { S.bridge = null; S.bridgeErr = ''; }
    renderBridge();
    return S.bridge;
  },
  async call(name, input, approved, signal) {
    const r = await fetch(Bridge.url() + '/bridge/call', { method: 'POST', headers: Bridge.headers(), body: JSON.stringify({ chat: S.chat.id, turn: String(S.turn), name, input, approved: !!approved }), signal });
    if (r.status === 202) return { confirm: (await r.json()).confirm };
    if (!r.ok) throw await API.readErr(r);
    return await r.json();
  },
  async upload(files) {
    const fd = new FormData(); fd.append('chat', S.chat.id);
    for (const f of files) fd.append('files', f, f.name);
    const r = await fetch(Bridge.url() + '/bridge/upload', { method: 'POST', headers: { 'x-bridge-key': S.cfg.bridge_key || '' }, body: fd });
    if (!r.ok) throw await API.readErr(r);
    return (await r.json()).files || [];
  },
  async restoreClipboard(turn) {
    const r = await fetch(Bridge.url() + '/bridge/clipboard/restore', { method: 'POST', headers: Bridge.headers(), body: JSON.stringify({ chat: S.chat.id, turn: String(turn) }) });
    if (!r.ok) throw await API.readErr(r);
  },
};

function renderBridge() {
  const b = $('#bridge-state');
  if (S.bridge) { b.textContent = 'TokenSaver: connected (' + S.bridge.profile + ')'; b.className = 'ok'; }
  else if (!S.cfg || !S.cfg.bridge) { b.textContent = 'TokenSaver: off'; b.className = ''; }
  else { b.textContent = S.bridgeErr ? 'TokenSaver: ' + S.bridgeErr : 'TokenSaver: not running · browser tools only'; b.className = S.bridgeErr ? 'err' : ''; }
}

// ---------- browser tools (no bridge) ----------
const Local = {
  async folderList() { return (await DB.raw('folders')) || []; },
  async addFolder() {
    if (!window.showDirectoryPicker) throw new Error('this browser cannot share folders (use Chrome or Edge)');
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    const list = await Local.folderList();
    if (!list.some(x => x.name === h.name)) list.push({ name: h.name, handle: h });
    await DB.rawPut('folders', list);
    return list;
  },
  async removeFolder(name) { const list = (await Local.folderList()).filter(x => x.name !== name); await DB.rawPut('folders', list); return list; },
  async resolve(path) {
    const parts = (path || '').split(/[\\/]+/).filter(Boolean);
    const list = await Local.folderList();
    if (!parts.length) return { root: true, list };
    const f = list.find(x => x.name === parts[0]);
    if (!f) throw new Error('no shared folder named "' + parts[0] + '"; shared: ' + (list.map(x => x.name).join(', ') || '(none)'));
    if ((await f.handle.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await f.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('permission for folder "' + f.name + '" was not granted');
    let dir = f.handle;
    for (let i = 1; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
    return { dir, leaf: parts.length > 1 ? parts[parts.length - 1] : null, top: f.handle, parts };
  },
  async files(input) {
    const a = input.action;
    const r = await Local.resolve(input.path);
    if (a === 'list') {
      if (r.root) return r.list.map(x => x.name + '/').join('\n') || '(no shared folders; add some in Settings)';
      let dir = r.dir; if (r.leaf) dir = await dir.getDirectoryHandle(r.leaf).catch(() => null) || (await (async () => { throw new Error('not a folder: ' + input.path); })());
      const out = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') out.push(name + '/');
        else { const f = await h.getFile(); out.push(name + '  ' + f.size + ' B  ' + new Date(f.lastModified).toISOString().slice(0, 16)); }
        if (out.length >= 500) { out.push('… more'); break; }
      }
      return out.join('\n') || '(empty)';
    }
    if (r.root || !r.leaf) throw new Error('give a file path');
    if (a === 'read') {
      const f = await (await r.dir.getFileHandle(r.leaf)).getFile();
      if (f.size > 20e6) throw new Error('file too large');
      const lines = (await f.text()).split('\n');
      const from = Math.max(1, input.from || 1), n = input.lines > 0 ? input.lines : 200;
      const chunk = lines.slice(from - 1, from - 1 + n);
      const head = `${r.parts.join('/')}: lines ${from}-${from + chunk.length - 1} of ${lines.length}\n`;
      return head + chunk.map((l, i) => (from + i) + ': ' + l).join('\n');
    }
    if (a === 'write') {
      const h = await r.dir.getFileHandle(r.leaf, { create: true });
      const w = await h.createWritable(); await w.write(input.text || ''); await w.close();
      return 'wrote ' + (input.text || '').length + ' chars to ' + r.parts.join('/');
    }
    if (a === 'delete') { await r.dir.removeEntry(r.leaf); return 'deleted ' + r.parts.join('/'); }
    throw new Error('unknown action: ' + a);
  },
  async screenshot() {
    if (!S.screen || !S.screen.active) {
      S.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false, preferCurrentTab: false });
      S.screen.getVideoTracks()[0].onended = () => { S.screen = null; };
    }
    const v = document.createElement('video'); v.srcObject = S.screen; v.muted = true; await v.play(); await sleep(150);
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0); v.pause();
    const url = c.toDataURL('image/jpeg', 0.7);
    return { text: `screenshot ${c.width}x${c.height}`, images: [{ mime: 'image/jpeg', data: url.split(',')[1] }] };
  },
  async clipboard(input) {
    if (input.action === 'read') return await navigator.clipboard.readText();
    await navigator.clipboard.writeText(input.text || ''); return 'clipboard set (' + (input.text || '').length + ' chars)';
  },
  async run(name, input) {
    if (name === 'files') return await Local.files(input || {});
    if (name === 'screenshot') return await Local.screenshot();
    if (name === 'clipboard') return await Local.clipboard(input || {});
    throw new Error('unknown tool ' + name);
  },
};

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: true });
function md(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });
  const div = el('div', 'md');
  div.innerHTML = html;
  div.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  div.querySelectorAll('pre').forEach(pre => {
    const b = el('button', 'copy ghost', 'copy');
    b.onclick = () => { navigator.clipboard.writeText(pre.innerText.replace(/copy$/, '')); b.textContent = 'copied'; setTimeout(() => b.textContent = 'copy', 1200); };
    pre.appendChild(b);
  });
  return div;
}

// ---------- state ----------
async function loadAll() {
  S.cfg = Object.assign({}, C.DEFAULTS, await DB.get('settings', {}));
  S.cfg.auto = Object.assign({}, C.DEFAULT_MODELS, S.cfg.auto || {});
  S.chats = await DB.get('chats', []);
  S.projects = await DB.get('projects', []);
  S.usage = await DB.get('usage', []);
  if (S.project && !S.projects.some(p => p.id === S.project)) setProject('');
  renderProjectList(); renderChatList(); renderMeter(); renderBridge();
}
const saveSettings = () => DB.put('settings', S.cfg);
const saveChats = () => DB.put('chats', S.chats.map(c => ({ id: c.id, title: c.title, cost: c.cost, project_id: c.project_id, model: c.model, updated: c.updated })));
async function saveChat(c) { c.updated = Date.now(); await DB.put('chat:' + c.id, c); const m = S.chats.find(x => x.id === c.id); if (m) { m.title = c.title; m.cost = c.cost; m.model = c.model; } await saveChats(); }
const saveProjects = () => DB.put('projects', S.projects);
async function logUsage(rec) { rec.time = new Date().toISOString(); S.usage.push(rec); if (S.usage.length > 20000) S.usage = S.usage.slice(-15000); await DB.put('usage', S.usage); renderMeter(); }

async function loadModels() {
  try { S.models = await API.models(); } catch (e) { S.models = []; }
  renderModelSelect();
}

function renderMeter() {
  const s = C.summarize(S.usage, C.cycleStart(S.cfg.budget_day));
  const pct = S.cfg.budget > 0 ? Math.min(100, s.cost / S.cfg.budget * 100) : 0;
  const f = $('#meter-fill');
  f.style.width = pct + '%';
  f.className = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  $('#meter-spent').textContent = fmt$(s.cost);
  $('#meter-budget').textContent = '$' + S.cfg.budget;
}

function setProject(id) { S.project = id || ''; localStorage.setItem('apichat.project', S.project); }

function renderProjectList() {
  const list = $('#project-list'); list.innerHTML = '';
  for (const p of S.projects) {
    const item = el('div', 'chat-item' + (S.project === p.id ? ' active' : ''));
    item.appendChild(el('span', 't', p.name));
    const n = S.chats.filter(c => c.project_id === p.id).length;
    item.appendChild(el('span', 'c', n ? String(n) : ''));
    const x = el('span', 'x', '⚙'); x.title = 'Project settings';
    x.onclick = (ev) => { ev.stopPropagation(); openProject(p.id); };
    item.appendChild(x);
    item.onclick = async () => {
      setProject(S.project === p.id ? '' : p.id);
      renderProjectList(); renderChatList();
      const inProj = S.chats.filter(c => c.project_id === S.project);
      if (S.project && !(S.chat && S.chat.project_id === S.project)) { if (inProj.length) await openChat(inProj[0].id); else await newChat(); }
    };
    list.appendChild(item);
  }
  $('#chats-label').textContent = S.project ? 'Project chats' : 'All chats';
}

function renderChatList() {
  const list = $('#chat-list'); list.innerHTML = '';
  for (const c of S.chats) {
    if (S.project && c.project_id !== S.project) continue;
    const item = el('div', 'chat-item' + (S.chat && S.chat.id === c.id ? ' active' : ''));
    item.appendChild(el('span', 't', c.title || 'New chat'));
    item.appendChild(el('span', 'c', c.cost ? fmt$(c.cost) : ''));
    const x = el('span', 'x', '✕'); x.title = 'Delete';
    x.onclick = async (ev) => {
      ev.stopPropagation(); if (!confirm('Delete this chat?')) return;
      if (S.chat && S.chat.id === c.id && S.busy) stop();
      S.chats = S.chats.filter(x => x.id !== c.id); await DB.del('chat:' + c.id); await saveChats();
      if (S.chat && S.chat.id === c.id) { S.chat = null; await newChat(); }
      renderProjectList(); renderChatList();
    };
    item.appendChild(x);
    item.onclick = () => openChat(c.id);
    list.appendChild(item);
  }
}

function modelOptions() {
  const opts = [];
  const seen = new Set();
  for (const m of S.models) { if (!/^claude-/.test(m.id) || seen.has(m.id)) continue; seen.add(m.id); opts.push([m.id, m.display_name || m.id]); }
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) if (!seen.has(id)) opts.push([id, id]);
  return opts;
}

function renderModelSelect() {
  const sel = $('#model'); sel.innerHTML = '';
  const add = (v, t) => { const o = el('option', '', t); o.value = v; sel.appendChild(o); };
  add('', 'Default (' + (S.cfg.model || 'auto') + ')');
  add('auto', 'Auto (cheapest that fits)');
  for (const [v, t] of modelOptions()) add(v, t);
  sel.value = S.chat ? (S.chat.model || '') : '';
}

// ---------- chats ----------
async function newChat() {
  const c = { id: C.uid(), title: '', cost: 0, project_id: S.project, model: '', messages: [], usage: C.emptyUsage(), turns: 0, created: Date.now() };
  S.chats.unshift({ id: c.id, title: '', cost: 0, project_id: c.project_id, model: '' });
  await DB.put('chat:' + c.id, c); await saveChats();
  await openChat(c.id);
}

async function openChat(id) {
  if (S.busy && S.chat && S.chat.id !== id) { notice('Finish or stop the current reply first.', 'err'); return; }
  const c = await DB.get('chat:' + id);
  if (!c) { S.chats = S.chats.filter(x => x.id !== id); await saveChats(); renderChatList(); return; }
  S.chat = c; S.cards = {}; S.live = null;
  localStorage.setItem('apichat.last', id);
  $('#title').value = c.title || '';
  $('#chat-cost').textContent = c.cost ? fmt$(c.cost) : '';
  if (c.project_id && c.project_id !== S.project) { setProject(c.project_id); renderProjectList(); }
  const proj = S.projects.find(p => p.id === c.project_id);
  const badge = $('#project-badge');
  badge.classList.toggle('hidden', !proj);
  if (proj) { badge.textContent = '▸ ' + proj.name; badge.onclick = () => openProject(proj.id); }
  renderModelSelect(); renderChatList(); renderMessages();
  setBusy(S.busy && S.chat.id === id);
  $('#input').focus();
}

function setBusy(b) {
  S.busy = b;
  $('#send').classList.toggle('hidden', b);
  $('#stop').classList.toggle('hidden', !b);
  if (!b) setStatus('');
}

function setStatus(text) {
  S.status = text;
  const s = $('#status'); s.innerHTML = '';
  if (text) { s.appendChild(el('span', 'pulse')); s.appendChild(document.createTextNode(text)); }
}

// ---------- rendering messages ----------
function renderUser(msg) {
  const wrap = el('div', 'msg user');
  const col = el('div'); col.style.maxWidth = '80%';
  const row = el('div', 'attach-row');
  let text = '';
  for (const b of msg.content) {
    if (b.type === 'image') { const img = el('img'); img.src = 'data:' + b.source.media_type + ';base64,' + b.source.data; row.appendChild(img); }
    else if (b.type === 'document') row.appendChild(el('span', 'file-chip', '📄 ' + (b.title || 'document')));
    else if (b.type === 'text') text += b.text;
  }
  const { text: t, notes } = C.splitNotes(text);
  for (const n of notes) { const m = n.match(/^(?:Attached file|Image|PDF|File) "([^"]+)"/); if (m && !row.textContent.includes(m[1])) row.appendChild(el('span', 'file-chip', '📎 ' + m[1])); }
  if (row.childNodes.length) col.appendChild(row);
  const bubble = el('div', 'bubble', t.trim() || (row.childNodes.length ? '' : '(empty)'));
  bubble.style.maxWidth = 'none';
  if (t.trim()) col.appendChild(bubble);
  wrap.appendChild(col);
  return wrap;
}

function toolCard(block) {
  const card = el('div', 'tool');
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'dot'));
  head.appendChild(el('span', 'name', block.name));
  head.appendChild(el('span', 'sum', C.summarizeInput(block.input)));
  card.appendChild(head);
  const body = el('div', 'tool-body');
  body.appendChild(el('div', 'lbl', 'input'));
  body.appendChild(el('pre', '', JSON.stringify(block.input, null, 2)));
  body.appendChild(el('div', 'lbl result-lbl hidden', 'result'));
  card.appendChild(body);
  head.onclick = () => card.classList.toggle('open');
  S.cards[block.id] = card;
  return card;
}

function fillResult(id, text, images, isErr) {
  const card = S.cards[id]; if (!card) return;
  card.classList.add('done'); card.classList.remove('running'); if (isErr) card.classList.add('err');
  const body = $('.tool-body', card);
  $('.result-lbl', body).classList.remove('hidden');
  if (text) body.appendChild(el('pre', '', text));
  for (const src of images || []) { const img = el('img'); img.src = src; body.appendChild(img); }
  if (isErr) card.classList.add('open');
}

function searchCard(block) {
  const card = el('div', 'tool search');
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'dot'));
  head.appendChild(el('span', 'name', 'web_search'));
  head.appendChild(el('span', 'sum', (block.input && block.input.query) || ''));
  card.appendChild(head);
  card.appendChild(el('div', 'tool-body'));
  head.onclick = () => card.classList.toggle('open');
  S.cards[block.id] = card;
  return card;
}

function fillSearch(block) {
  const card = S.cards[block.tool_use_id]; if (!card) return;
  card.classList.add('done');
  const body = $('.tool-body', card);
  if (!Array.isArray(block.content)) { card.classList.add('err'); body.appendChild(el('pre', '', JSON.stringify(block.content))); return; }
  $('.sum', card).textContent += ' · ' + block.content.length + ' results';
  for (const it of block.content) { const a = el('a', '', it.title || it.url); a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; const d = el('div'); d.appendChild(a); body.appendChild(d); }
}

function renderAssistant(msg) {
  const wrap = el('div', 'msg assistant');
  const bubble = el('div', 'bubble');
  for (const b of msg.content) {
    if (b.type === 'text') { if (b.text && b.text.trim()) bubble.appendChild(md(b.text)); }
    else if (b.type === 'tool_use') bubble.appendChild(toolCard(b));
    else if (b.type === 'server_tool_use') bubble.appendChild(searchCard(b));
    else if (b.type === 'web_search_tool_result') fillSearch(b);
    else if (b.type === 'thinking' && b.thinking) { const d = el('details', 'think'); d.appendChild(el('summary', '', 'Thought')); d.appendChild(el('pre', '', b.thinking)); bubble.appendChild(d); }
  }
  wrap.appendChild(bubble);
  return wrap;
}

function usageLine(u, cost) {
  return el('div', 'usage-line', `${fmt$(cost)} · in ${u.input || 0} + cached ${u.cache_read || 0} · out ${u.output || 0}` + (u.web_searches ? ` · ${u.web_searches} searches` : ''));
}

function renderMessages() {
  const box = $('#messages'); box.innerHTML = ''; S.cards = {};
  for (const m of S.chat.messages) {
    if (m.role === 'user') {
      if (m.content.length && m.content[0].type === 'tool_result') {
        for (const r of m.content) {
          let text = '', images = [];
          const c = r.content;
          if (typeof c === 'string') text = c;
          else for (const b of c || []) { if (b.type === 'text') text += b.text; if (b.type === 'image') images.push('data:' + b.source.media_type + ';base64,' + b.source.data); }
          fillResult(r.tool_use_id, text, images, !!r.is_error);
        }
      } else box.appendChild(renderUser(m));
    } else { const node = renderAssistant(m); if (m.usage) node.appendChild(usageLine(m.usage, m.cost)); box.appendChild(node); }
  }
  scrollDown(true);
}

function scrollDown(force) {
  const box = $('#messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || near) box.scrollTop = box.scrollHeight;
}

function notice(text, cls, button) {
  const n = el('div', 'notice ' + (cls || ''), text);
  if (button) { const b = el('button', 'ghost', button.label); b.onclick = button.onclick; n.appendChild(b); }
  $('#messages').appendChild(n);
  scrollDown();
}

// ---------- live streaming ----------
function liveEl() {
  if (S.live) return S.live;
  const wrap = el('div', 'msg assistant');
  const bubble = el('div', 'bubble');
  const think = el('details', 'think hidden'); think.appendChild(el('summary', '', 'Thinking')); think.appendChild(el('pre'));
  const body = el('div', 'md');
  bubble.appendChild(think); bubble.appendChild(body);
  wrap.appendChild(bubble);
  $('#messages').appendChild(wrap);
  S.live = { wrap, body, think, text: '', thinking: '', raf: null };
  return S.live;
}
function liveRender() {
  const l = S.live; if (!l || l.raf) return;
  l.raf = requestAnimationFrame(() => {
    l.raf = null;
    const n = md(l.text); l.body.replaceWith(n); l.body = n;
    if (l.thinking) { l.think.classList.remove('hidden'); $('pre', l.think).textContent = l.thinking; }
    scrollDown();
  });
}
function liveClear() { if (S.live) { S.live.wrap.remove(); S.live = null; } }

// ---------- confirm cards ----------
function askConfirm(tool, action, args) {
  return new Promise((resolve) => {
    const box = el('div', 'confirm');
    box.appendChild(el('div', 'q', `Allow ${tool}${action ? ' (' + action + ')' : ''}?`));
    box.appendChild(el('pre', '', JSON.stringify(args, null, 2)));
    const btns = el('div', 'btns');
    const ok = el('button', 'primary', 'Allow'); const no = el('button', '', 'Deny');
    const done = (v) => { box.remove(); resolve(v); };
    ok.onclick = () => done(true); no.onclick = () => done(false);
    btns.appendChild(ok); btns.appendChild(no); box.appendChild(btns);
    $('#messages').appendChild(box); scrollDown(true);
    S.pendingConfirm = () => done(false);
  });
}

// ---------- the turn ----------
function errMsg(e) { return (e && e.message) || String(e); }

async function runTool(tu, signal) {
  const id = tu.id, name = tu.name, input = tu.input || {};
  const card = S.cards[id]; if (card) card.classList.add('running');
  setStatus('running ' + name + ' ' + C.summarizeInput(input));
  let text = '', images = [], isErr = false;
  try {
    if (name === 'project') {
      text = await runProjectTool(input);
    } else if (S.bridge) {
      let r = await Bridge.call(name, input, false, signal);
      if (r.confirm) {
        setStatus('waiting for permission');
        const ok = await askConfirm(r.confirm.tool, r.confirm.action, input);
        if (!ok) throw new Error('the user did not allow this action');
        r = await Bridge.call(name, input, true, signal);
      }
      text = r.text || ''; images = r.images || []; isErr = !!r.error;
      if (r.clipboard_changed) S.clipboardChanged = true;
    } else {
      if (C.browserConfirm(S.cfg, name, input)) {
        setStatus('waiting for permission');
        if (!(await askConfirm(name, input.action || '', input))) throw new Error('the user did not allow this action');
      }
      const r = await Local.run(name, input);
      if (typeof r === 'string') text = r; else { text = r.text || ''; images = r.images || []; }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    isErr = true; text = errMsg(e);
  }
  await logUsage({ kind: 'tool', chat: S.chat.id, tool: name, action: input.action || '', error: isErr });
  const content = [];
  if (!text && !images.length) text = '(no output)';
  if (text) content.push(C.text(text));
  const thumbs = [];
  for (const im of images) { content.push(C.image(im.mime, im.data)); thumbs.push('data:' + im.mime + ';base64,' + im.data); }
  fillResult(id, text, thumbs, isErr);
  return C.toolResult(id, content, isErr);
}

async function route(text, c) {
  const cfg = S.cfg;
  const router = cfg.router || cfg.auto.simple;
  const hist = c.messages.length > 1 ? ` The conversation already has ${c.messages.length} messages.` : '';
  const req = { model: router, max_tokens: 5, stream: true,
    system: [C.text('Rate how capable a model the next request needs. Reply with one digit only: 1 = quick chat, a short factual question, a tiny edit, or a simple file lookup; 2 = normal work: multi-step tasks on the PC, writing, summarizing, code changes, research; 3 = hard: tricky debugging, long careful analysis, subtle reasoning, high-stakes or irreversible actions.' + hist)],
    messages: [{ role: 'user', content: [C.text('Request:\n' + text.slice(0, 3000))] }] };
  try {
    const res = await API.stream(req, () => {}, S.abort.signal);
    const cost = C.cost(res.model || router, res.usage);
    c.cost += cost;
    await logUsage({ kind: 'api', chat: c.id, model: res.model || router, input: res.usage.input, output: res.usage.output, cache_write: res.usage.cache_write, cache_read: res.usage.cache_read, cost });
    return C.routeChoice(res.content.map(b => b.text || '').join(''), cfg.auto);
  } catch (e) { if (e.name === 'AbortError') throw e; return cfg.auto.normal; }
}

async function makeTitle(c) {
  const model = S.cfg.router || 'claude-haiku-5-5';
  const u = C.lastUserText(c.messages).slice(0, 1500), a = C.lastAssistantText(c.messages).slice(0, 800);
  const req = { model, max_tokens: 20, stream: true, system: [C.text('Write a title for this chat: 2 to 6 words, no quotes, no trailing period, same language as the user.')], messages: [{ role: 'user', content: [C.text('User: ' + u + '\n\nAssistant: ' + a)] }] };
  try {
    const res = await API.stream(req, () => {}, S.abort.signal);
    const cost = C.cost(res.model || model, res.usage);
    c.cost += cost;
    await logUsage({ kind: 'api', chat: c.id, model: res.model || model, input: res.usage.input, output: res.usage.output, cost });
    return C.cleanTitle(res.content.map(b => b.text || '').join(''));
  } catch (e) { return ''; }
}

async function runTurn(c, userText) {
  const cfg = S.cfg;
  S.abort = new AbortController(); const signal = S.abort.signal;
  S.turn = c.turns; S.clipboardChanged = false;
  setBusy(true);
  const fail = (e) => { liveClear(); if (e.name === 'AbortError') notice('Stopped.'); else notice(errMsg(e), 'err'); };
  try {
    await Bridge.info();
    let model = c.model || cfg.model;
    if (model === 'auto') { setStatus('choosing model'); model = await route(userText, c); }
    setStatus('using ' + model);
    const project = c.project_id ? S.projects.find(p => p.id === c.project_id) : null;
    const tools = C.toolList(cfg, S.bridge ? S.bridge.tools : null, project);
    const system = C.systemBlocks(cfg, c, project, S.bridge);
    for (let round = 0; round < (cfg.max_tool_rounds || 40); round++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      setStatus('thinking');
      const req = C.buildRequest(cfg, model, system, c.messages, tools);
      liveClear();
      let res;
      try {
        res = await API.stream(req, (ev) => {
          if (ev.kind === 'text') { const l = liveEl(); l.text += ev.text; liveRender(); }
          else if (ev.kind === 'thinking') { const l = liveEl(); l.thinking += ev.text; liveRender(); }
          else if (ev.kind === 'block_start' && (ev.block.type === 'tool_use' || ev.block.type === 'server_tool_use')) setStatus('preparing ' + (ev.block.name || ''));
        }, signal);
      } catch (e) {
        if (e.name === 'AbortError' && S.live && S.live.text.trim()) { c.messages.push({ role: 'assistant', content: [C.text(S.live.text.trim())] }); await saveChat(c); }
        throw e;
      }
      const usedModel = res.model || model;
      const cost = C.cost(usedModel, res.usage);
      const msg = { role: 'assistant', content: res.content, usage: res.usage, cost };
      c.messages.push(msg); c.cost += cost; C.addUsage(c.usage, res.usage);
      await saveChat(c);
      await logUsage({ kind: 'api', chat: c.id, model: usedModel, input: res.usage.input, output: res.usage.output, cache_write: res.usage.cache_write, cache_read: res.usage.cache_read, searches: res.usage.web_searches, cost });
      liveClear();
      const node = renderAssistant(msg); node.appendChild(usageLine(res.usage, cost)); $('#messages').appendChild(node);
      $('#chat-cost').textContent = fmt$(c.cost); scrollDown();
      if (res.stop_reason === 'tool_use') {
        const results = [];
        for (const tu of res.content.filter(b => b.type === 'tool_use')) {
          if (signal.aborted) { results.push(C.toolResult(tu.id, [C.text('stopped by the user')], true)); continue; }
          results.push(await runTool(tu, signal));
        }
        c.messages.push({ role: 'user', content: results });
        await saveChat(c);
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        continue;
      }
      if (res.stop_reason === 'pause_turn') continue;
      if (res.stop_reason === 'max_tokens') notice('The reply hit the output limit.');
      break;
    }
    if (!c.title) {
      setStatus('naming chat');
      const t = await makeTitle(c);
      if (t) { c.title = t; $('#title').value = t; await saveChat(c); renderChatList(); }
    }
    if (S.clipboardChanged) { const turn = S.turn; notice('The clipboard was changed during this turn.', '', { label: 'Restore clipboard', onclick: async (ev) => { try { await Bridge.restoreClipboard(turn); ev.target.textContent = 'restored'; } catch (e) { ev.target.textContent = errMsg(e); } } }); }
  } catch (e) { fail(e); }
  finally { S.abort = null; S.pendingConfirm = null; setBusy(false); await saveChat(c); renderChatList(); renderMeter(); }
}

function stop() { if (S.abort) S.abort.abort(); if (S.pendingConfirm) S.pendingConfirm(); }

// ---------- composer ----------
function renderChips() {
  const c = $('#chips'); c.innerHTML = '';
  S.atts.forEach((a, i) => {
    const chip = el('div', 'chip');
    if (a.file.type.startsWith('image/')) { const img = el('img'); img.src = URL.createObjectURL(a.file); chip.appendChild(img); }
    chip.appendChild(el('span', '', a.file.name + ' (' + Math.round(a.file.size / 1024) + ' KB)'));
    if (!a.file.type.startsWith('image/')) {
      const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = a.inline; cb.onchange = () => a.inline = cb.checked;
      lab.appendChild(cb); lab.appendChild(document.createTextNode('send inline')); lab.title = 'Unchecked: saved on the PC and read with TokenSaver (cheaper; needs APIChat running). Checked: sent to the API in full.';
      chip.appendChild(lab);
    }
    const rm = el('span', 'rm', '✕'); rm.onclick = () => { S.atts.splice(i, 1); renderChips(); };
    chip.appendChild(rm);
    c.appendChild(chip);
  });
}
function addFiles(files) { for (const f of files) S.atts.push({ file: f, inline: !S.bridge }); renderChips(); }

const readB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });

async function prepareAtts() {
  const out = [];
  const bridged = !!(await Bridge.info());
  let paths = {};
  if (bridged && S.atts.length) {
    try { for (const f of await Bridge.upload(S.atts.map(a => a.file))) paths[f.name] = f.path; } catch (e) { notice('Upload to PC failed: ' + errMsg(e), 'err'); }
  }
  for (const a of S.atts) {
    const f = a.file, mime = (f.type || '').toLowerCase();
    const att = { name: f.name, mime, size: f.size, inline: a.inline, path: paths[f.name] };
    if (C.IMAGE_MIMES[mime]) att.b64 = await readB64(f);
    else if (mime === 'application/pdf' && a.inline) att.b64 = await readB64(f);
    else if (C.textLike(mime, f.name) && a.inline) att.text = await f.text();
    out.push(att);
  }
  return { atts: out, bridged };
}

async function send() {
  const text = $('#input').value.trim();
  if (!text && !S.atts.length) return;
  if (S.busy) return;
  if (!S.cfg.api_key) { openSettings(); return; }
  if (!S.chat) await newChat();
  const c = S.chat;
  setBusy(true); setStatus('starting');
  let prepared;
  try { prepared = await prepareAtts(); } catch (e) { setBusy(false); notice(errMsg(e), 'err'); return; }
  const msg = C.userBlocks(text, prepared.atts, prepared.bridged);
  c.messages.push(msg); c.turns++;
  await saveChat(c);
  $('#messages').appendChild(renderUser(msg)); scrollDown(true);
  $('#input').value = ''; autosize(); S.atts = []; renderChips();
  await runTurn(c, text);
}

function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(220, t.scrollHeight) + 'px'; }

// ---------- project tool ----------
async function runProjectTool(a) {
  const p = S.projects.find(x => x.id === S.chat.project_id);
  if (!p) throw new Error('this chat is not in a project');
  p.memory = p.memory || []; p.files = p.files || [];
  switch (a.action) {
    case 'remember': {
      const t = (a.text || '').trim(); if (!t) throw new Error('text is required');
      if (t.length > 2000) throw new Error('note too long');
      if (p.memory.length >= 500) throw new Error('memory is full; forget something first');
      const n = { id: C.uid().slice(-6), text: t, time: Date.now() }; p.memory.push(n); await saveProjects(); return 'remembered [' + n.id + ']';
    }
    case 'forget': {
      if (!(a.ids && a.ids.length) && !(a.contains || '').trim()) throw new Error('give ids or contains');
      const before = p.memory.length;
      p.memory = p.memory.filter(n => !((a.ids || []).includes(n.id) || (a.contains && n.text.toLowerCase().includes(a.contains.toLowerCase()))));
      await saveProjects(); const n = before - p.memory.length; return n ? 'forgot ' + n + ' note(s)' : 'nothing matched';
    }
    case 'list': return p.memory.length ? p.memory.map(n => '[' + n.id + '] ' + n.text).join('\n') : '(no notes)';
    case 'files': return p.files.length ? p.files.map(f => f.name + ' (' + f.size + ' bytes)').join('\n') : '(no files)';
    case 'read': {
      const f = p.files.find(x => x.name === a.name); if (!f) throw new Error('no such file');
      const data = await DB.get('pfile:' + p.id + ':' + f.name);
      if (!data) throw new Error('file content missing');
      if (data.text != null) return data.text;
      throw new Error('this file is not text; only text files can be read here');
    }
  }
  throw new Error('unknown action: ' + a.action);
}

// ---------- settings ----------
function modal(title, body) { $('#modal-title').textContent = title; const b = $('#modal-body'); b.innerHTML = ''; b.appendChild(body); $('#modal').classList.remove('hidden'); }
function closeModal() { if (!S.cfg.api_key && $('#modal-title').textContent === 'Settings') { const m = $('#modal .save-msg'); if (m) { m.textContent = 'Paste the API key and click Save first'; m.style.color = 'var(--err)'; } return; } $('#modal').classList.add('hidden'); }

function field(form, label, input, hint) { form.appendChild(el('label', '', label)); form.appendChild(input); if (hint) form.appendChild(el('div', 'hint', hint)); return input; }
function inp(type, value, attrs = {}) { const i = el('input'); i.type = type; i.value = value == null ? '' : value; Object.assign(i, attrs); return i; }
function sel(options, value) { const s = el('select'); for (const [v, t] of options) { const o = el('option', '', t); o.value = v; s.appendChild(o); } s.value = value; return s; }
function chk(value) { const i = el('input'); i.type = 'checkbox'; i.checked = !!value; i.style.width = 'auto'; return i; }
function ta(value, rows = 4) { const t = el('textarea'); t.value = value || ''; t.rows = rows; return t; }

async function openSettings() {
  const s = S.cfg;
  const form = el('div', 'form');
  form.appendChild(el('h3', '', 'API'));
  const key = field(form, 'API key', inp('password', '', { placeholder: s.api_key ? 'paste a new key to replace the saved one' : 'sk-ant-…' }), s.api_key ? '✓ A key is saved (encrypted with your password)' : 'No key yet. Paste the key from the Claude Console and click Save.');
  const budget = field(form, 'Monthly credit (USD)', inp('number', s.budget, { step: '1' }));
  const budgetDay = field(form, 'Billing cycle day', inp('number', s.budget_day, { min: 1, max: 28 }), 'Day of month your credits refresh');
  const userName = field(form, 'Your name', inp('text', s.user_name));
  form.appendChild(el('h3', '', 'Models'));
  const modelOpts = [['auto', 'auto'], ...modelOptions()];
  const model = field(form, 'Default model', sel(modelOpts, s.model));
  const aSimple = field(form, 'Auto: simple', sel(modelOpts.slice(1), s.auto.simple));
  const aNormal = field(form, 'Auto: normal', sel(modelOpts.slice(1), s.auto.normal));
  const aHard = field(form, 'Auto: hard', sel(modelOpts.slice(1), s.auto.hard));
  const effort = field(form, 'Effort', sel([['', 'model default'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']], s.effort || ''), 'Lower effort = fewer thinking tokens');
  const thinking = field(form, 'Thinking', sel([['', 'model default'], ['adaptive', 'adaptive']], s.thinking || ''));
  const maxTokens = field(form, 'Max output tokens', inp('number', s.max_tokens));
  const cacheTTL = field(form, 'Cache TTL', sel([['1h', '1 hour (best for chatting with pauses)'], ['5m', '5 minutes']], s.cache_ttl || '1h'));
  const webSearch = field(form, 'API web search', chk(s.web_search), '$0.01 per search; TokenSaver web stays free');
  const webMax = field(form, 'Max searches per reply', inp('number', s.web_search_max_uses));
  const sys = field(form, 'Extra instructions', ta(s.system_prompt, 3));
  form.appendChild(el('h3', '', 'TokenSaver (APIChat on this PC)'));
  const bridgeOn = field(form, 'Use TokenSaver', chk(s.bridge), 'When APIChat is running on this PC, its tools (files, commands, screen, browser, Office…) are used. Otherwise the browser tools below.');
  const bridgeUrl = field(form, 'APIChat address', inp('text', s.bridge_url));
  const bridgeKey = field(form, 'Bridge key', inp('password', s.bridge_key, { placeholder: 'from APIChat Settings → APIChatHTML bridge' }));
  const bridgeMsg = el('div', 'hint'); form.appendChild(el('label')); form.appendChild(bridgeMsg);
  form.appendChild(el('h3', '', 'Browser tools (used without APIChat)'));
  const confirmW = field(form, 'Ask before writing or deleting files', chk(s.confirm_writes !== false));
  const folders = el('div', 'proj-files');
  const renderFolders = async () => {
    const list = await Local.folderList(); folders.innerHTML = '';
    if (!list.length) folders.appendChild(el('div', 'hint', 'No shared folders. Claude can only read and write inside folders you add here.'));
    for (const f of list) { const row = el('div', 'proj-row'); row.appendChild(el('span', 't', f.name)); const x = el('span', 'x', '✕'); x.onclick = async () => { await Local.removeFolder(f.name); renderFolders(); }; row.appendChild(x); folders.appendChild(row); }
  };
  renderFolders();
  form.appendChild(el('label', '', 'Shared folders')); form.appendChild(folders);
  const addF = el('button', 'ghost', '+ Share a folder'); addF.onclick = async () => { try { await Local.addFolder(); renderFolders(); } catch (e) { if (e.name !== 'AbortError') bridgeMsg.textContent = errMsg(e); } };
  form.appendChild(el('label')); form.appendChild(addF);
  form.appendChild(el('h3', '', 'Password'));
  const pw1 = field(form, 'New password', inp('password', '', { placeholder: 'leave empty to keep the current one', autocomplete: 'new-password' }));
  const pw2 = field(form, 'Repeat', inp('password', '', { autocomplete: 'new-password' }), 'Everything this page stores is encrypted with it. There is no reset: a forgotten password means the chats and key are gone.');
  form.appendChild(el('h3', '', 'Data'));
  const dataRow = el('div'); dataRow.style.display = 'flex'; dataRow.style.gap = '8px';
  const exp = el('button', 'ghost', 'Export backup'); exp.onclick = exportData;
  const imp = el('button', 'ghost', 'Import backup'); imp.onclick = importData;
  const wipe = el('button', 'danger', 'Erase everything'); wipe.onclick = async () => { if (!confirm('Erase all chats, projects, usage and settings from this browser?')) return; await DB.clear(); localStorage.clear(); location.reload(); };
  dataRow.appendChild(exp); dataRow.appendChild(imp); dataRow.appendChild(wipe);
  form.appendChild(el('label')); form.appendChild(dataRow);
  const actions = el('div', 'form-actions full');
  const msg = el('span', 'save-msg');
  const save = el('button', 'primary', 'Save');
  save.onclick = async () => {
    msg.style.color = '';
    try {
      if (pw1.value || pw2.value) {
        if (pw1.value !== pw2.value) throw new Error('the passwords do not match');
        if (pw1.value.length < 4) throw new Error('password too short');
        await changePassword(pw1.value);
      }
      Object.assign(S.cfg, {
        budget: +budget.value, budget_day: +budgetDay.value, user_name: userName.value, model: model.value,
        auto: { simple: aSimple.value, normal: aNormal.value, hard: aHard.value }, effort: effort.value, thinking: thinking.value,
        max_tokens: +maxTokens.value, cache_ttl: cacheTTL.value, web_search: webSearch.checked, web_search_max_uses: +webMax.value,
        system_prompt: sys.value, bridge: bridgeOn.checked, bridge_url: bridgeUrl.value.trim(), bridge_key: bridgeKey.value.trim(), confirm_writes: confirmW.checked,
      });
      if (key.value.trim()) S.cfg.api_key = key.value.trim();
      await saveSettings();
      msg.textContent = 'Saved'; renderMeter(); loadModels();
      S.bridgeAt = 0; const b = await Bridge.info(true); bridgeMsg.textContent = b ? 'Connected to APIChat ' + b.version + ' (TokenSaver ' + b.tokensaver + ', ' + b.tools.length + ' tools)' : (S.bridgeErr || 'APIChat not reachable; browser tools will be used');
      if (S.cfg.api_key) setTimeout(closeModal, 700); else { msg.textContent = 'Saved, but no API key yet'; msg.style.color = 'var(--err)'; }
    } catch (e) { msg.textContent = errMsg(e); msg.style.color = 'var(--err)'; }
  };
  actions.appendChild(msg); actions.appendChild(save);
  const box = el('div'); box.appendChild(form); box.appendChild(actions);
  modal('Settings', box);
  if (!s.api_key) setTimeout(() => key.focus(), 50);
}

async function changePassword(pw) {
  const { vault, key } = await C.newVault(pw);
  const keys = (await DB.keys()).filter(k => k !== 'vault' && k !== 'folders');
  const values = {};
  for (const k of keys) values[k] = await DB.get(k);
  S.key = key;
  for (const k of keys) if (values[k] !== undefined) await DB.put(k, values[k]);
  await DB.rawPut('vault', vault);
}

async function exportData() {
  const out = { apichat_html: 1, exported: new Date().toISOString(), data: {} };
  for (const k of await DB.keys()) if (k !== 'vault' && k !== 'folders') out.data[k] = await DB.get(k);
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'apichat-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
}
function importData() {
  const pick = el('input'); pick.type = 'file'; pick.accept = '.json';
  pick.onchange = async () => {
    const f = pick.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j.apichat_html) throw new Error('not an APIChat backup');
      if (!confirm('Import ' + Object.keys(j.data).length + ' records? Existing chats with the same ids are replaced.')) return;
      for (const [k, v] of Object.entries(j.data)) await DB.put(k, v);
      await loadAll(); if (S.chat) await openChat(S.chat.id);
      notice('Backup imported.');
    } catch (e) { notice('Import failed: ' + errMsg(e), 'err'); }
  };
  pick.click();
}

// ---------- projects ----------
async function newProject() {
  const name = prompt('Project name');
  if (!name || !name.trim()) return;
  const p = { id: C.uid(), name: name.trim(), instructions: '', files: [], memory: [], created: Date.now() };
  S.projects.push(p); await saveProjects();
  setProject(p.id); renderProjectList(); renderChatList();
  await newChat();
  openProject(p.id);
}

async function openProject(id) {
  const p = S.projects.find(x => x.id === id); if (!p) return;
  p.files = p.files || []; p.memory = p.memory || [];
  const form = el('div', 'form');
  const name = field(form, 'Name', inp('text', p.name));
  const instr = field(form, 'Instructions', ta(p.instructions, 5), 'Sent with every chat in this project.');
  form.appendChild(el('h3', '', 'Files'));
  form.appendChild(el('div', 'hint', 'Kept in this browser (encrypted). Chats in this project see the list; text files can be read with the project tool.'));
  const files = el('div', 'proj-files');
  const renderFiles = () => {
    files.innerHTML = '';
    if (!p.files.length) files.appendChild(el('div', 'hint', 'No files yet'));
    for (const f of p.files) {
      const row = el('div', 'proj-row');
      row.appendChild(el('span', 't', f.name));
      row.appendChild(el('span', 'c', (f.size / 1024).toFixed(f.size > 10240 ? 0 : 1) + ' KB'));
      const x = el('span', 'x', '✕'); x.title = 'Remove';
      x.onclick = async () => { if (!confirm('Remove ' + f.name + ' from the project?')) return; p.files = p.files.filter(y => y.name !== f.name); await DB.del('pfile:' + p.id + ':' + f.name); await saveProjects(); renderFiles(); };
      row.appendChild(x);
      files.appendChild(row);
    }
  };
  renderFiles();
  form.appendChild(files);
  const pick = el('input'); pick.type = 'file'; pick.multiple = true; pick.hidden = true;
  pick.onchange = async () => {
    for (const f of pick.files) {
      if (f.size > 5e6) { alert(f.name + ' is too large (5 MB max)'); continue; }
      const rec = C.textLike(f.type, f.name) ? { text: await f.text() } : { b64: await readB64(f), mime: f.type };
      await DB.put('pfile:' + p.id + ':' + f.name, rec);
      p.files = p.files.filter(y => y.name !== f.name); p.files.push({ name: f.name, size: f.size, mime: f.type });
    }
    await saveProjects(); renderFiles(); pick.value = '';
  };
  const addBtn = el('button', 'ghost', '+ Add files'); addBtn.onclick = () => pick.click();
  form.appendChild(addBtn); form.appendChild(pick);
  form.appendChild(el('h3', '', 'Memory'));
  form.appendChild(el('div', 'hint', 'Notes the assistant keeps across all chats in this project. It adds them itself; you can add or remove them here.'));
  const notes = el('div', 'proj-notes');
  const renderNotes = () => {
    notes.innerHTML = '';
    if (!p.memory.length) notes.appendChild(el('div', 'hint', 'Nothing remembered yet'));
    for (const n of p.memory) {
      const row = el('div', 'proj-row');
      const t = el('span', 't', n.text); t.title = n.text; t.style.whiteSpace = 'normal';
      row.appendChild(t);
      const x = el('span', 'x', '✕'); x.title = 'Forget';
      x.onclick = async () => { p.memory = p.memory.filter(y => y.id !== n.id); await saveProjects(); renderNotes(); };
      row.appendChild(x);
      notes.appendChild(row);
    }
  };
  renderNotes();
  form.appendChild(notes);
  const noteIn = inp('text', '', { placeholder: 'Add a note and press Enter' });
  noteIn.onkeydown = async (e) => { if (e.key !== 'Enter' || !noteIn.value.trim()) return; e.preventDefault(); p.memory.push({ id: C.uid().slice(-6), text: noteIn.value.trim(), time: Date.now() }); noteIn.value = ''; await saveProjects(); renderNotes(); };
  form.appendChild(noteIn);
  const actions = el('div', 'form-actions full');
  const msg = el('span', 'save-msg');
  const del = el('button', 'danger', 'Delete project');
  del.onclick = async () => {
    if (!confirm('Delete project "' + p.name + '"? Its files and memory are removed; the chats stay.')) return;
    for (const f of p.files) await DB.del('pfile:' + p.id + ':' + f.name);
    S.projects = S.projects.filter(x => x.id !== id); await saveProjects();
    for (const c of S.chats) if (c.project_id === id) { c.project_id = ''; const full = await DB.get('chat:' + c.id); if (full) { full.project_id = ''; await DB.put('chat:' + c.id, full); } }
    await saveChats();
    if (S.project === id) setProject('');
    $('#modal').classList.add('hidden'); renderProjectList(); renderChatList();
    if (S.chat) await openChat(S.chat.id);
  };
  const save = el('button', 'primary', 'Save');
  save.onclick = async () => {
    p.name = name.value.trim() || p.name; p.instructions = instr.value;
    await saveProjects(); msg.textContent = 'Saved'; renderProjectList(); if (S.chat) await openChat(S.chat.id); setTimeout(() => $('#modal').classList.add('hidden'), 400);
  };
  actions.appendChild(del); actions.appendChild(msg); actions.appendChild(save);
  const box = el('div'); box.appendChild(form); box.appendChild(actions);
  modal('Project', box);
}

function openUsage() {
  const s = C.summarize(S.usage, C.cycleStart(S.cfg.budget_day)); const box = el('div');
  const stat = (k, v) => { const d = el('div', 'stat'); d.appendChild(el('span', '', k)); d.appendChild(el('span', '', v)); box.appendChild(d); };
  stat('Billing cycle', new Date(s.from).toLocaleDateString() + ' → today');
  stat('Spent', fmt$(s.cost) + ' of $' + S.cfg.budget);
  stat('API calls', s.calls); stat('Tool calls', s.tool_calls);
  stat('Input tokens', s.input.toLocaleString() + ' (cached ' + s.cache_read.toLocaleString() + ')');
  stat('Output tokens', s.output.toLocaleString()); stat('Web searches', s.searches);
  if (s.by_day.length) {
    box.appendChild(el('h3', '', 'By day'));
    const bar = el('div', 'bar'); const max = Math.max(...s.by_day.map(d => d.cost));
    for (const d of s.by_day) { const b = el('div'); b.style.height = (max ? d.cost / max * 100 : 0) + '%'; b.title = d.day + ' ' + fmt$(d.cost); bar.appendChild(b); }
    box.appendChild(bar);
  }
  box.appendChild(el('h3', '', 'By model'));
  for (const [m, c] of Object.entries(s.by_model).sort((a, b) => b[1] - a[1])) stat(m, fmt$(c));
  box.appendChild(el('h3', '', 'Tools used'));
  for (const [t, n] of Object.entries(s.by_tool).sort((a, b) => b[1] - a[1])) stat(t, n + '×');
  modal('Usage', box);
}

// ---------- lock screen ----------
async function unlock() {
  const vault = await DB.raw('vault');
  const lock = $('#lock'); const form = $('#lock-form'); const msg = $('#lock-msg');
  $('#lock-setup').classList.toggle('hidden', !!vault);
  $('#lock-open').classList.toggle('hidden', !vault);
  lock.classList.remove('hidden');
  return new Promise((resolve) => {
    form.onsubmit = async (e) => {
      e.preventDefault(); msg.textContent = '';
      const btn = $('button', form); btn.disabled = true;
      try {
        if (!vault) {
          const api = $('#lock-key').value.trim(), p1 = $('#lock-pw1').value, p2 = $('#lock-pw2').value;
          if (!api) throw new Error('paste your API key');
          if (p1.length < 4) throw new Error('choose a password of at least 4 characters');
          if (p1 !== p2) throw new Error('the passwords do not match');
          msg.textContent = 'setting up…';
          const v = await C.newVault(p1);
          S.key = v.key; await DB.rawPut('vault', v.vault);
          await DB.put('settings', Object.assign({}, C.DEFAULTS, { api_key: api }));
        } else {
          msg.textContent = 'checking…';
          const key = await C.openVault(vault, $('#lock-pw').value);
          if (!key) throw new Error('wrong password');
          S.key = key;
        }
        lock.classList.add('hidden'); form.reset(); resolve();
      } catch (err) { msg.textContent = errMsg(err); }
      finally { btn.disabled = false; }
    };
    setTimeout(() => (vault ? $('#lock-pw') : $('#lock-key')).focus(), 50);
  });
}

// ---------- wiring ----------
$('#new-chat').onclick = () => { if (S.busy) { notice('Stop the current reply first.', 'err'); return; } newChat(); };
$('#new-project').onclick = () => newProject().catch(e => notice('Could not create project: ' + errMsg(e), 'err'));
$('#send').onclick = send;
$('#stop').onclick = stop;
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!S.busy) send(); } });
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('paste', (e) => { const files = [...(e.clipboardData.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
document.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dragover'); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
$('#title').addEventListener('change', async () => { if (!S.chat) return; S.chat.title = $('#title').value; await saveChat(S.chat); renderChatList(); });
$('#model').addEventListener('change', async () => { if (!S.chat) return; S.chat.model = $('#model').value; await saveChat(S.chat); });
$('#open-settings').onclick = () => openSettings().catch(e => notice('Settings failed to open: ' + errMsg(e), 'err'));
$('#open-usage').onclick = openUsage;
$('#lock-btn').onclick = () => location.reload();
$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
$('#head').addEventListener('click', (e) => { if (e.target.id === 'head') $('#side').classList.toggle('show'); });
window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });

(async () => {
  await DB.open();
  await unlock();
  await loadAll();
  loadModels();
  Bridge.info(true);
  const last = localStorage.getItem('apichat.last');
  const visible = S.chats.filter(c => !S.project || c.project_id === S.project);
  if (last && S.chats.some(c => c.id === last)) await openChat(last);
  else if (visible.length) await openChat(visible[0].id);
  else await newChat();
  if (!S.cfg.api_key) openSettings();
})();
})();
