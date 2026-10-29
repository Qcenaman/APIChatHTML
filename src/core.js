// Pure logic shared by the page and the tests: prices, stream parsing,
// history trimming, prompt building. No DOM, no storage.
const Core = (() => {
  const DEFAULT_MODELS = { simple: 'claude-haiku-5-5', normal: 'claude-sonnet-5-5', hard: 'claude-opus-5-5' };

  const DEFAULTS = {
    api_key: '', api_base: 'https://api.anthropic.com', api_version: '2023-06-01',
    budget: 200, budget_day: 1, user_name: '',
    model: 'auto', auto: { ...DEFAULT_MODELS }, router: 'claude-haiku-5-5',
    effort: '', thinking: '', max_tokens: 16000, cache_ttl: '1h',
    web_search: false, web_search_max_uses: 5, screenshots_per_turn: 3,
    max_history_chars: 600000, max_tool_rounds: 40, system_prompt: '',
    bridge_url: 'http://127.0.0.1:47821', bridge_key: '', bridge: true,
    confirm_writes: true,
  };

  // USD per million tokens: input, output, cache write 5m, cache write 1h, cache read.
  const PRICES = {
    'claude-fable-5-1': [10, 50, 12.5, 20, 0.25],
    'claude-mythos-5-1': [10, 50, 12.5, 20, 0.25],
    'claude-fable-5': [10, 50, 12.5, 20, 1],
    'claude-mythos-5': [10, 50, 12.5, 20, 1],
    'claude-opus-5-5': [4, 20, 5, 8, 0.2],
    'claude-opus-5': [5, 25, 6.25, 10, 0.5],
    'claude-opus-4': [5, 25, 6.25, 10, 0.5],
    'claude-opus-4-1': [15, 75, 18.75, 30, 1.5],
    'claude-opus-4-0': [15, 75, 18.75, 30, 1.5],
    'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.1],
    'claude-sonnet-5': [2, 10, 2.5, 4, 0.2],
    'claude-sonnet-4': [3, 15, 3.75, 6, 0.3],
    'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01],
    'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
    'claude-haiku-3-5': [0.8, 4, 1, 1.6, 0.08],
    'claude-3-5-haiku': [0.8, 4, 1, 1.6, 0.08],
  };
  const WEB_SEARCH_PRICE = 0.01;

  function priceFor(model, extra) {
    let best = null, blen = -1;
    const look = (m) => { for (const k of Object.keys(m || {})) if (model.startsWith(k) && k.length > blen) { best = m[k]; blen = k.length; } };
    look(PRICES); look(extra);
    return best;
  }

  function emptyUsage() { return { input: 0, output: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, web_searches: 0 }; }

  function cost(model, u, extra) {
    const p = priceFor(model || '', extra);
    if (!p) return 0;
    const total = (u.input || 0) + (u.cache_write || 0) + (u.cache_read || 0);
    const mult = model.startsWith('claude-haiku-5-5') && total > 100000 ? 5 : 1;
    const w5 = Math.max(0, (u.cache_write || 0) - (u.cache_write_1h || 0));
    const c = (u.input || 0) * p[0] + (u.output || 0) * p[1] + w5 * p[2] + (u.cache_write_1h || 0) * p[3] + (u.cache_read || 0) * p[4];
    return c * mult / 1e6 + (u.web_searches || 0) * WEB_SEARCH_PRICE;
  }

  function addUsage(a, b) {
    for (const k of Object.keys(emptyUsage())) a[k] = (a[k] || 0) + (b[k] || 0);
    return a;
  }

  function mergeUsage(u, raw) {
    if (!raw) return;
    if (raw.input_tokens > 0) u.input = raw.input_tokens;
    if (raw.output_tokens > 0) u.output = raw.output_tokens;
    if (raw.cache_creation_input_tokens > 0) u.cache_write = raw.cache_creation_input_tokens;
    if (raw.cache_creation && raw.cache_creation.ephemeral_1h_input_tokens > 0) u.cache_write_1h = raw.cache_creation.ephemeral_1h_input_tokens;
    if (raw.cache_read_input_tokens > 0) u.cache_read = raw.cache_read_input_tokens;
    if (raw.server_tool_use && raw.server_tool_use.web_search_requests > 0) u.web_searches = raw.server_tool_use.web_search_requests;
  }

  // streamParser consumes SSE text from the Messages API and rebuilds the
  // content blocks. fn gets {kind:'text'|'thinking'|'block_start'|'block_stop', ...}.
  function streamParser(fn) {
    const res = { id: '', model: '', stop_reason: '', usage: emptyUsage(), content: [] };
    const blocks = {}, partial = {}, texts = {};
    let started = false, buf = '', data = '', error = null;
    const handle = (ev) => {
      switch (ev.type) {
        case 'message_start': {
          started = true;
          const m = ev.message || {};
          res.id = m.id || ''; res.model = m.model || '';
          mergeUsage(res.usage, m.usage);
          break;
        }
        case 'content_block_start': {
          const b = Object.assign({}, ev.content_block || {});
          blocks[ev.index] = b;
          if (b.type === 'tool_use' || b.type === 'server_tool_use') partial[ev.index] = '';
          if (b.type === 'text') texts[ev.index] = b.text || '';
          fn({ kind: 'block_start', index: ev.index, block: b });
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta || {}, b = blocks[ev.index];
          if (d.type === 'text_delta') { if (texts[ev.index] !== undefined) texts[ev.index] += d.text; fn({ kind: 'text', index: ev.index, text: d.text }); }
          else if (d.type === 'input_json_delta') { if (partial[ev.index] !== undefined) partial[ev.index] += d.partial_json; }
          else if (d.type === 'thinking_delta') { if (b) b.thinking = (b.thinking || '') + d.thinking; fn({ kind: 'thinking', index: ev.index, text: d.thinking }); }
          else if (d.type === 'signature_delta') { if (b) b.signature = (b.signature || '') + d.signature; }
          else if (d.type === 'citations_delta') { if (b && d.citation) { b.citations = (b.citations || []).concat([d.citation]); } }
          break;
        }
        case 'content_block_stop': {
          const b = blocks[ev.index]; if (!b) break;
          if (partial[ev.index] !== undefined) { const s = partial[ev.index].trim(); let inp = {}; if (s) { try { inp = JSON.parse(s); } catch (e) { inp = {}; } } b.input = inp; }
          if (texts[ev.index] !== undefined) b.text = texts[ev.index];
          fn({ kind: 'block_stop', index: ev.index, block: b });
          break;
        }
        case 'message_delta': {
          if (ev.delta && ev.delta.stop_reason) res.stop_reason = ev.delta.stop_reason;
          mergeUsage(res.usage, ev.usage);
          break;
        }
        case 'error': error = Object.assign(new Error((ev.error && ev.error.message) || 'stream error'), { type: ev.error && ev.error.type, status: 0 }); break;
      }
    };
    const flush = () => { if (!data) return; const raw = data; data = ''; let ev; try { ev = JSON.parse(raw); } catch (e) { return; } handle(ev); };
    const line = (l) => {
      if (l === '') { flush(); return; }
      if (l.startsWith('data:')) data += l.slice(5).trim();
    };
    return {
      feed(chunk) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { let l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.endsWith('\r')) l = l.slice(0, -1); line(l); if (error) return error; }
        return null;
      },
      end() {
        if (buf) { line(buf); buf = ''; }
        flush();
        if (error) return { error, started };
        if (!started) return { error: new Error('empty response from the API'), started: false };
        res.content = Object.keys(blocks).map(Number).sort((a, b) => a - b).map(i => blocks[i]);
        return { result: res, started: true };
      },
    };
  }

  // ---- messages ----
  const text = (s) => ({ type: 'text', text: s });
  const image = (mime, b64) => ({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
  const document_ = (mime, b64, title) => { const b = { type: 'document', source: { type: 'base64', media_type: mime, data: b64 } }; if (title) b.title = title; return b; };
  const textDocument = (s, title) => { const b = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: s } }; if (title) b.title = title; return b; };
  const toolResult = (id, content, isErr) => { const b = { type: 'tool_result', tool_use_id: id }; if (content && content.length) b.content = content; if (isErr) b.is_error = true; return b; };
  const cache = (b, ttl) => { const cc = { type: 'ephemeral' }; if (ttl === '1h') cc.ttl = '1h'; return Object.assign({}, b, { cache_control: cc }); };

  const IMAGE_MIMES = { 'image/jpeg': 1, 'image/png': 1, 'image/gif': 1, 'image/webp': 1 };
  const TEXT_EXT = ['.txt', '.md', '.csv', '.json', '.log', '.py', '.go', '.js', '.ts', '.html', '.css', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.bat', '.ps1', '.sh', '.toml'];
  function textLike(mime, name) {
    if ((mime || '').startsWith('text/')) return true;
    const n = (name || '').toLowerCase();
    return TEXT_EXT.some(e => n.endsWith(e));
  }

  // userBlocks builds the user message. atts: [{name, mime, size, inline, b64?, text?, path?}].
  // path is set when the file was saved on the PC through the bridge.
  function userBlocks(txt, atts, bridged) {
    const blocks = [], notes = [];
    for (const a of atts || []) {
      const mime = (a.mime || '').toLowerCase();
      const saved = a.path ? ` is also saved at ${a.path}` : '';
      if (IMAGE_MIMES[mime] && a.b64) { blocks.push(image(mime, a.b64)); if (saved) notes.push(`Image "${a.name}"${saved}`); }
      else if (mime === 'application/pdf' && a.inline && a.b64) { blocks.push(document_(mime, a.b64, a.name)); if (saved) notes.push(`PDF "${a.name}"${saved}`); }
      else if (textLike(mime, a.name) && a.inline && a.text != null && a.text.length < 200000) { blocks.push(textDocument(a.text, a.name)); if (saved) notes.push(`File "${a.name}"${saved}`); }
      else if (a.path) notes.push(`Attached file "${a.name}" saved at ${a.path} (${a.size} bytes); read it with TokenSaver (read, office, media, local_ai) as needed`);
      else notes.push(`Attached file "${a.name}" (${a.size} bytes) could not be sent: ${bridged ? 'upload failed' : 'without TokenSaver only images, PDFs and text files marked "send inline" can be read'}`);
    }
    let msg = txt || '';
    if (notes.length) msg = (msg + '\n\n[' + notes.join('\n') + ']').trim();
    if (!msg.trim()) msg = '(see attached)';
    blocks.push(text(msg));
    return { role: 'user', content: blocks };
  }

  function splitNotes(t) {
    const m = (t || '').match(/\n\n\[((?:Attached file|Image|PDF|File) [\s\S]*)\]$/);
    if (!m) return { text: t, notes: [] };
    return { text: t.slice(0, m.index), notes: m[1].split('\n') };
  }

  // withCache marks the last block of the last message as a cache breakpoint.
  function withCache(msgs) {
    if (!msgs.length) return msgs;
    const out = msgs.slice();
    const last = out[out.length - 1];
    if (!last.content || !last.content.length) return out;
    const blocks = last.content.slice();
    let lb = blocks[blocks.length - 1];
    if (lb.type !== 'thinking' && lb.type !== 'redacted_thinking') lb = cache(lb, '');
    blocks[blocks.length - 1] = lb;
    out[out.length - 1] = { role: last.role, content: blocks };
    return out;
  }

  const startsTurn = (m) => m.role === 'user' && m.content && m.content.length && m.content[0].type !== 'tool_result';

  // trimHistory drops the oldest turns when the conversation is too long,
  // never splitting a tool_use from its result.
  function trimHistory(msgs, max) {
    if (!max || max <= 0) return msgs;
    const sizes = msgs.map(m => JSON.stringify(m).length);
    let total = sizes.reduce((a, b) => a + b, 0), start = 0;
    while (total > max) {
      let next = -1;
      for (let i = start + 1; i < msgs.length; i++) if (startsTurn(msgs[i])) { next = i; break; }
      if (next < 0) break;
      for (let i = start; i < next; i++) total -= sizes[i];
      start = next;
    }
    return msgs.slice(start);
  }

  function lastUserText(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'user') for (const b of m.content) if (b.type === 'text') return b.text;
    }
    return '';
  }

  function lastAssistantText(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { let a = ''; for (const b of msgs[i].content) if (b.type === 'text') a = b.text; return a; }
    }
    return '';
  }

  function routeChoice(out, auto) {
    const a = Object.assign({}, DEFAULT_MODELS, auto || {});
    if (/1/.test(out)) return a.simple;
    if (/3/.test(out)) return a.hard;
    return a.normal;
  }

  function cleanTitle(t) {
    t = (t || '').split('\n')[0].trim().replace(/^["'.]+|["'.]+$/g, '');
    return t.length > 60 ? t.slice(0, 60) : t;
  }

  // ---- prompts ----
  const BASE_SYSTEM_BRIDGE = `You are APIChat, a desktop assistant running on the user's own Windows PC. You have TokenSaver, a set of tools that run locally and return short results, so you can read files, run commands, use the screen, the browser, Office files and more, exactly like a desktop assistant.

Working rules:
- Use TokenSaver whenever it can do the job instead of asking the user to do it. Act; don't just describe.
- Spend as few tokens as possible: window text or ocr before screenshot; screenshot with a question before a real screenshot; local_ai to read or sort many files; read with lines, grep or pages rather than whole files; web (free) before web_search (paid, $0.01 per search).
- Before clicking or typing in other apps, check the window text first, and re-read positions if time passed. Set the clipboard only when the task needs it.
- Dry-run deletes, renames and overwrites, and say what a destructive action will do before running it.
- Long work returns a job id; poll job status rather than repeating the call.
- Keep replies short and concrete. Use Markdown. Don't restate what the tools printed; summarize what matters.`;

  const BASE_SYSTEM_BROWSER = `You are APIChat, an assistant running as a single web page in the user's browser. No desktop tool server is connected, so you cannot run commands, read other windows or drive a browser. You do have a few browser tools: files (read, write, list and delete inside the folders the user has shared with this page), screenshot (the user is asked to share their screen) and clipboard (read or set the clipboard).

Working rules:
- Use the tools when they can do the job instead of asking the user to do it. If something needs the full TokenSaver tools (commands, other apps, Office files, web pages), say so briefly and suggest starting APIChat on the PC.
- Spend as few tokens as possible: read files with line ranges rather than whole files; take screenshots only when text won't do.
- Say what a destructive action will do before running it.
- Keep replies short and concrete. Use Markdown. Don't restate what the tools printed; summarize what matters.`;

  function systemBlocks(cfg, chat, project, bridge, now) {
    let s = bridge ? BASE_SYSTEM_BRIDGE + '\n\nTokenSaver notes: ' + (bridge.instructions || '') : BASE_SYSTEM_BROWSER;
    if (bridge && bridge.profile === 'guest') {
      s += '\n\nThis user has a guest profile. File access is limited to: ' + ((bridge.guest_folders || []).join('; ') || '(no folders yet; ask the owner to add some in Settings)') +
        '. Uploaded files live under ' + (bridge.upload_dir || '') + '. Some actions ask the user for permission first; if refused, don\'t retry them.';
    }
    if (cfg.system_prompt) s += '\n\n' + cfg.system_prompt;
    const blocks = [cache(text(s), cfg.cache_ttl)];
    const d = now || new Date();
    let dyn = 'Today is ' + d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '.';
    if (cfg.user_name) dyn += ' The user\'s name is ' + cfg.user_name + '.';
    if (project) dyn += projectPrompt(project);
    if (chat && chat.instructions) dyn += '\n\nInstructions for this chat:\n' + chat.instructions;
    blocks.push(text(dyn));
    return blocks;
  }

  const MAX_MEMORY_PROMPT = 12000;
  function projectPrompt(p) {
    let s = '\n\nThis chat belongs to the project "' + p.name + '".';
    if ((p.instructions || '').trim()) s += '\nProject instructions:\n' + p.instructions.trim();
    const files = p.files || [];
    if (!files.length) s += '\nProject files: (none)';
    else {
      s += '\nProject files (use the project tool, action "read", to read one when it matters):';
      files.slice(0, 60).forEach(f => { s += '\n- ' + f.name + ' (' + f.size + ' bytes)'; });
      if (files.length > 60) s += '\n- … and more; use the project tool, action "files"';
    }
    s += '\nProject memory is a list of notes kept across all chats in this project. Use the project tool: `remember` a fact, decision or preference that later chats in this project should know (and nothing else), `forget` to remove a note that is wrong or outdated. Save new memory only when it is durable and not already in the list.';
    const mem = p.memory || [];
    if (!mem.length) s += '\nProject memory: (nothing yet)';
    else {
      s += '\nProject memory:';
      let used = 0;
      for (let i = mem.length - 1; i >= 0; i--) {
        const line = '\n- [' + mem[i].id + '] ' + mem[i].text;
        if (used + line.length > MAX_MEMORY_PROMPT) { s += '\n- (older notes omitted; forget some to make room)'; break; }
        used += line.length; s += line;
      }
    }
    return s;
  }

  const PROJECT_TOOL = {
    name: 'project',
    description: 'Memory and files of the current project, shared by all its chats. remember: save a short durable note (a fact, decision or preference the user stated). forget: remove notes by id or by text. list: show all notes. files: list the project files. read: return a project file as text.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['remember', 'forget', 'list', 'files', 'read'] },
        text: { type: 'string', description: 'remember: the note to save' },
        ids: { type: 'array', items: { type: 'string' }, description: 'forget: note ids' },
        contains: { type: 'string', description: 'forget: remove notes containing this text' },
        name: { type: 'string', description: 'read: the file name' },
      },
      required: ['action'],
    },
  };

  const BROWSER_TOOLS = [
    {
      name: 'files',
      description: 'Files in the folders the user shared with this page (Settings → Shared folders). list: entries of a folder (path like "Docs" or "Docs/sub"). read: text of a file, optionally a line range. write: create or replace a text file (asks the user first). delete: remove a file (asks the user first). Paths start with the shared folder\'s name.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read', 'write', 'delete'] },
          path: { type: 'string', description: 'folder or file path, e.g. "Docs/notes.txt"; empty lists the shared folders' },
          from: { type: 'integer', description: 'read: first line (1-based)' },
          lines: { type: 'integer', description: 'read: how many lines (default 200)' },
          text: { type: 'string', description: 'write: the full file content' },
        },
        required: ['action'],
      },
    },
    {
      name: 'screenshot',
      description: 'Take a screenshot of a screen or window the user chooses to share (the browser asks them). Returns an image; use it only when text will not do. Optional question is answered from the image by you.',
      input_schema: { type: 'object', properties: { question: { type: 'string' } } },
    },
    {
      name: 'clipboard',
      description: 'read: the clipboard text (the browser may ask the user). set: put text on the clipboard.',
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'set'] }, text: { type: 'string' } }, required: ['action'] },
    },
  ];

  function toolList(cfg, bridgeTools, project) {
    const out = (bridgeTools && bridgeTools.length ? bridgeTools : BROWSER_TOOLS).map(t => Object.assign({}, t));
    if (project) out.push(Object.assign({}, PROJECT_TOOL));
    if (out.length) out[out.length - 1] = cache(out[out.length - 1], cfg.cache_ttl);
    if (cfg.web_search) out.push({ type: 'web_search_20250305', name: 'web_search', max_uses: cfg.web_search_max_uses > 0 ? cfg.web_search_max_uses : 5 });
    return out;
  }

  function buildRequest(cfg, model, system, msgs, tools) {
    const req = { model, max_tokens: cfg.max_tokens || 16000, system, messages: withCache(trimHistory(msgs, cfg.max_history_chars)), tools, stream: true };
    if (cfg.thinking === 'adaptive') req.thinking = { type: 'adaptive' };
    if (cfg.effort) req.output_config = { effort: cfg.effort };
    return req;
  }

  // ---- usage ----
  function cycleStart(day, now) {
    const d = now || new Date();
    day = Math.min(28, Math.max(1, day || 1));
    let s = new Date(d.getFullYear(), d.getMonth(), day);
    if (s > d) s = new Date(d.getFullYear(), d.getMonth() - 1, day);
    return s;
  }

  function summarize(records, from) {
    const s = { from: from.toISOString(), cost: 0, calls: 0, tool_calls: 0, input: 0, output: 0, cache_read: 0, searches: 0, by_model: {}, by_tool: {}, by_day: [] };
    const days = {};
    for (const r of records) {
      if (new Date(r.time) < from) continue;
      if (r.kind === 'tool') { s.tool_calls++; s.by_tool[r.tool] = (s.by_tool[r.tool] || 0) + 1; continue; }
      s.calls++; s.cost += r.cost || 0; s.input += r.input || 0; s.output += r.output || 0; s.cache_read += r.cache_read || 0; s.searches += r.searches || 0;
      s.by_model[r.model] = (s.by_model[r.model] || 0) + (r.cost || 0);
      const day = r.time.slice(0, 10); days[day] = (days[day] || 0) + (r.cost || 0);
    }
    s.by_day = Object.keys(days).sort().map(day => ({ day, cost: days[day] }));
    return s;
  }

  function summarizeInput(input) {
    if (!input || typeof input !== 'object') return '';
    const parts = [];
    for (const k of ['action', 'path', 'command', 'query', 'url', 'question', 'window', 'name', 'text', 'pattern']) {
      if (input[k] != null && typeof input[k] !== 'object') parts.push(String(input[k]).slice(0, 80));
    }
    if (Array.isArray(input.steps)) parts.push(input.steps.map(s => s.op || Object.keys(s)[0]).join(', '));
    if (Array.isArray(input.paths)) parts.push(input.paths.join(', ').slice(0, 80));
    return parts.join(' · ');
  }

  // Which browser-tool calls need the user's OK first.
  function browserConfirm(cfg, name, input) {
    if (name === 'files' && input && (input.action === 'write' || input.action === 'delete')) return cfg.confirm_writes !== false;
    if (name === 'screenshot') return true;
    return false;
  }


  // ---- password crypto (WebCrypto: PBKDF2 -> AES-GCM) ----
  const subtle = () => (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : (typeof globalThis.crypto !== 'undefined' ? globalThis.crypto.subtle : null);
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  const unb64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const randomBytes = (n) => { const u = new Uint8Array(n); (globalThis.crypto || crypto).getRandomValues(u); return u; };
  const PBKDF2_ITER = 600000;

  async function deriveKey(password, saltB64) {
    const enc = new TextEncoder();
    const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', salt: unb64(saltB64), iterations: PBKDF2_ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, value) {
    const iv = randomBytes(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function decrypt(key, box) {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  // newVault makes the record that proves a password later: salt + an encrypted marker.
  async function newVault(password) {
    const salt = b64(randomBytes(16));
    const key = await deriveKey(password, salt);
    return { vault: { salt, check: await encrypt(key, 'apichat'), v: 1 }, key };
  }
  async function openVault(vault, password) {
    const key = await deriveKey(password, vault.salt);
    try { if ((await decrypt(key, vault.check)) !== 'apichat') return null; } catch (e) { return null; }
    return key;
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  return {
    DEFAULTS, DEFAULT_MODELS, PRICES, WEB_SEARCH_PRICE, priceFor, cost, emptyUsage, addUsage, mergeUsage, streamParser,
    text, image, document: document_, textDocument, toolResult, cache, textLike, IMAGE_MIMES, userBlocks, splitNotes,
    withCache, trimHistory, lastUserText, lastAssistantText, routeChoice, cleanTitle, systemBlocks, projectPrompt,
    PROJECT_TOOL, BROWSER_TOOLS, toolList, buildRequest, cycleStart, summarize, summarizeInput, browserConfirm, uid,
    b64, unb64, deriveKey, encrypt, decrypt, newVault, openVault, PBKDF2_ITER,
  };
})();
if (typeof module !== 'undefined') module.exports = Core;
