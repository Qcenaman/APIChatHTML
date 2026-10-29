// Builds the single-file app: node build.js  ->  APIChatHTML.html
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
let html = read('src/index.html');
html = html.replace('<!--CSS-->', () => read('src/app.css').replace(/<\/style/gi, '<\\/style'));
html = html.replace('<!--VENDOR-->', () => safe(read('vendor/marked.min.js')) + '\n' + safe(read('vendor/purify.min.js')));
html = html.replace('<!--CORE-->', () => safe(read('src/core.js')));
html = html.replace('<!--APP-->', () => safe(read('src/app.js')));
const out = path.join(__dirname, 'APIChatHTML.html');
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB');
