const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

test('cost uses the longest matching price prefix and the haiku long-context multiplier', () => {
  const u = { input: 1e6, output: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, web_searches: 0 };
  assert.equal(C.cost('claude-opus-5-5-20260101', u), 4);
  assert.equal(C.cost('claude-opus-5', u), 5);
  assert.equal(C.cost('claude-haiku-5-5', { ...u, input: 1000 }), 0.0001);
  assert.equal(C.cost('claude-haiku-5-5', u), 0.5);
  assert.equal(C.cost('unknown-model', u), 0);
  assert.equal(C.cost('claude-sonnet-5-5', { ...u, input: 0, web_searches: 3 }), 0.03);
  assert.equal(C.cost('claude-sonnet-5-5', { ...u, input: 0, cache_write: 1e6, cache_write_1h: 1e6 }), 4);
});

test('streamParser rebuilds blocks, tool input and usage', () => {
  const events = [];
  const p = C.streamParser(e => events.push(e));
  const lines = [
    'event: message_start', 'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-5-5","usage":{"input_tokens":10}}}', '',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}', '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}', '',
    'data: {"type":"content_block_stop","index":0}', '',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"files","input":{}}}', '',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"action\\":"}}', '',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"list\\"}"}}', '',
    'data: {"type":"content_block_stop","index":1}', '',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}', '',
  ].join('\n');
  // feed in odd-sized chunks to exercise buffering
  for (let i = 0; i < lines.length; i += 17) assert.equal(p.feed(lines.slice(i, i + 17)), null);
  const out = p.end();
  assert.equal(out.error, undefined);
  const r = out.result;
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.usage, { input: 10, output: 7, cache_write: 0, cache_write_1h: 0, cache_read: 0, web_searches: 0 });
  assert.equal(r.content[0].text, 'Hello');
  assert.deepEqual(r.content[1].input, { action: 'list' });
  assert.equal(events.filter(e => e.kind === 'text').map(e => e.text).join(''), 'Hello');
});

test('streamParser reports API errors and empty streams', () => {
  let p = C.streamParser(() => {});
  p.feed('data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n');
  assert.equal(p.end().error.message, 'busy');
  p = C.streamParser(() => {});
  assert.equal(p.end().error.message, 'empty response from the API');
});

test('trimHistory drops whole turns from the start and keeps tool pairs together', () => {
  const t = (s) => ({ role: 'user', content: [{ type: 'text', text: s }] });
  const a = (s) => ({ role: 'assistant', content: [{ type: 'text', text: s }] });
  const tr = () => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'r' }] }] });
  const msgs = [t('one'), a('reply'), tr(), a('x'), t('two'), a('y')];
  const trimmed = C.trimHistory(msgs, JSON.stringify(msgs[4]).length + JSON.stringify(msgs[5]).length + 1);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].content[0].text, 'two');
  assert.equal(C.trimHistory(msgs, 0), msgs);
});

test('withCache marks only the last block of the last message', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }];
  const out = C.withCache(msgs);
  assert.equal(out[0].content[0].cache_control, undefined);
  assert.deepEqual(out[0].content[1].cache_control, { type: 'ephemeral' });
  assert.equal(msgs[0].content[1].cache_control, undefined, 'input untouched');
});

test('userBlocks sends images and inline docs, notes saved paths, and explains unreadable files', () => {
  const m = C.userBlocks('hi', [
    { name: 'p.png', mime: 'image/png', size: 3, b64: 'AAA=' , path: 'C:\\u\\p.png' },
    { name: 'n.txt', mime: 'text/plain', size: 2, inline: true, text: 'ok' },
    { name: 'a.zip', mime: 'application/zip', size: 9, path: 'C:\\u\\a.zip' },
    { name: 'b.zip', mime: 'application/zip', size: 9 },
  ], false);
  assert.equal(m.content[0].type, 'image');
  assert.equal(m.content[1].type, 'document');
  const txt = m.content[2].text;
  assert.match(txt, /^hi\n\n\[Image "p.png" is also saved at/);
  assert.match(txt, /Attached file "a.zip" saved at C:\\u\\a.zip \(9 bytes\); read it with TokenSaver/);
  assert.match(txt, /Attached file "b.zip" \(9 bytes\) could not be sent: without TokenSaver/);
  const { text, notes } = C.splitNotes(txt);
  assert.equal(text, 'hi');
  assert.equal(notes.length, 3);
  assert.equal(C.userBlocks('', [], false).content[0].text, '(see attached)');
});

test('routeChoice, cleanTitle and summarizeInput', () => {
  assert.equal(C.routeChoice('1', {}), 'claude-haiku-5-5');
  assert.equal(C.routeChoice('3\n', { hard: 'claude-opus-5' }), 'claude-opus-5');
  assert.equal(C.routeChoice('maybe 2', {}), 'claude-sonnet-5-5');
  assert.equal(C.cleanTitle('"Fix the build."\nmore'), 'Fix the build');
  assert.equal(C.summarizeInput({ action: 'read', path: 'C:\\x', steps: [{ op: 'copy' }] }), 'read · C:\\x · copy');
});

test('toolList uses bridge tools when connected, browser tools otherwise, and adds project + web search', () => {
  const cfg = { ...C.DEFAULTS, web_search: true, web_search_max_uses: 2 };
  const b = C.toolList(cfg, [{ name: 'read', input_schema: {} }], { id: 'p' });
  assert.deepEqual(b.map(t => t.name), ['read', 'project', 'web_search']);
  assert.deepEqual(b[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(b[2].max_uses, 2);
  const l = C.toolList({ ...C.DEFAULTS }, null, null);
  assert.deepEqual(l.map(t => t.name), ['files', 'screenshot', 'clipboard']);
});

test('systemBlocks mentions the mode, project memory and chat instructions', () => {
  const cfg = { ...C.DEFAULTS, user_name: 'Q', system_prompt: 'Be brief.' };
  const proj = { name: 'Taxes', instructions: 'Use PHP.', files: [{ name: 'a.csv', size: 5 }], memory: [{ id: 'n1', text: 'Filing is in April' }] };
  const now = new Date(2026, 9, 29);
  const b = C.systemBlocks(cfg, { instructions: 'Reply in Tagalog' }, proj, { instructions: 'TS notes', profile: 'guest', guest_folders: ['D:\\Work'], upload_dir: 'D:\\up' }, now);
  assert.equal(b.length, 2);
  assert.deepEqual(b[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.match(b[0].text, /TokenSaver notes: TS notes/);
  assert.match(b[0].text, /guest profile.*D:\\Work/);
  assert.match(b[0].text, /Be brief\./);
  assert.match(b[1].text, /^Today is Thursday, 29 October 2026\. The user's name is Q\./);
  assert.match(b[1].text, /project "Taxes"[\s\S]*Use PHP\.[\s\S]*a\.csv[\s\S]*\[n1\] Filing is in April[\s\S]*Reply in Tagalog/);
  const nb = C.systemBlocks(cfg, null, null, null, now);
  assert.match(nb[0].text, /single web page/);
  assert.doesNotMatch(nb[0].text, /TokenSaver notes/);
});

test('cycleStart and summarize', () => {
  assert.equal(C.cycleStart(10, new Date(2026, 9, 29)).getTime(), new Date(2026, 9, 10).getTime());
  assert.equal(C.cycleStart(10, new Date(2026, 9, 3)).getTime(), new Date(2026, 8, 10).getTime());
  const from = new Date(2026, 9, 1);
  const s = C.summarize([
    { time: '2026-09-30T10:00:00Z', kind: 'api', model: 'm', cost: 9 },
    { time: '2026-10-02T10:00:00Z', kind: 'api', model: 'm', cost: 1, input: 5, output: 2, cache_read: 1, searches: 1 },
    { time: '2026-10-03T10:00:00Z', kind: 'api', model: 'n', cost: 2, input: 1, output: 1 },
    { time: '2026-10-03T11:00:00Z', kind: 'tool', tool: 'files' },
  ], from);
  assert.equal(s.cost, 3); assert.equal(s.calls, 2); assert.equal(s.tool_calls, 1);
  assert.equal(s.input, 6); assert.equal(s.searches, 1);
  assert.deepEqual(s.by_model, { m: 1, n: 2 });
  assert.deepEqual(s.by_tool, { files: 1 });
  assert.deepEqual(s.by_day, [{ day: '2026-10-02', cost: 1 }, { day: '2026-10-03', cost: 2 }]);
});

test('browserConfirm asks for writes, deletes and screenshots', () => {
  assert.equal(C.browserConfirm(C.DEFAULTS, 'files', { action: 'read' }), false);
  assert.equal(C.browserConfirm(C.DEFAULTS, 'files', { action: 'write' }), true);
  assert.equal(C.browserConfirm({ confirm_writes: false }, 'files', { action: 'delete' }), false);
  assert.equal(C.browserConfirm(C.DEFAULTS, 'screenshot', {}), true);
});

test('password vault opens only with the right password and round-trips data', async () => {
  const { vault, key } = await C.newVault('secret');
  assert.ok(await C.openVault(vault, 'secret'));
  assert.equal(await C.openVault(vault, 'wrong'), null);
  const box = await C.encrypt(key, { chats: [1, 2], note: 'héllo' });
  assert.notEqual(box.ct, '');
  assert.deepEqual(await C.decrypt(key, box), { chats: [1, 2], note: 'héllo' });
  const other = await C.openVault(vault, 'secret');
  assert.deepEqual(await C.decrypt(other, box), { chats: [1, 2], note: 'héllo' });
});
