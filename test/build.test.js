const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

test('the built file is self-contained and up to date', () => {
  const root = path.join(__dirname, '..');
  execFileSync(process.execPath, [path.join(root, 'build.js')], { stdio: 'ignore' });
  const html = fs.readFileSync(path.join(root, 'APIChatHTML.html'), 'utf8');
  assert.doesNotMatch(html, /<!--(CSS|VENDOR|CORE|APP)-->/);
  assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)=/i, 'no external files');
  assert.match(html, /marked v/);
  assert.match(html, /DOMPurify/);
  assert.match(html, /const Core = /);
  assert.match(html, /id="lock-form"/);
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g);
  assert.equal(scripts.length, 3);
  // every script block must parse
  for (const s of scripts) new Function(s.slice(8, -9));
});
