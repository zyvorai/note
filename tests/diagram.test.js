// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../public/diagram.js');
const MD = require('../public/md.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

test('flow diagrams: shapes, colours, edge styles, titles and directions', () => {
  const s = D.render('title: Signup\n(Start) -> Email #blue -> {Valid?}: yes\n{Valid?} --> Error #red: no\nEmail ---  [(Users DB)] #green\n{Valid?} -> ((Done))');
  assert.match(s, /<svg class="diagram"/); assert.match(s, /aria-label="Diagram \(flow\): Signup"/);
  assert.match(s, /<polygon/);                                   // diamond
  assert.match(s, /<ellipse/);                                   // circle
  assert.match(s, /rx="19"/);                                    // pill: radius is half the height
  assert.equal((s.match(/<path d="M[\d.]+ [\d.]+V/g) || []).length, 1);   // database body
  assert.match(s, /stroke="#5b5bd6"/); assert.match(s, /stroke="#c0392b"/); assert.match(s, /stroke="#2f8f5b"/);
  assert.match(s, /stroke-dasharray="6 4"/);                    // dashed edge
  assert.equal((s.match(/marker-end/g) || []).length, 4);       // four arrows; the `---` line has none
  assert.deepEqual(texts(s).filter((t) => ['yes', 'no', 'Signup', 'Valid?'].includes(t)).sort(), ['Signup', 'Valid?', 'yes', 'no'].sort());
  assert.ok(!texts(s).some((t) => t.includes('{') || t.includes('#')));          // markers never leak into labels
  const down = D.render('down\nA -> B'), right = D.render('A -> B');
  const y = (svg, n) => +new RegExp(`<rect x="[\\d.]+" y="([\\d.]+)"[^>]*/><text[^>]*>${n}<`).exec(svg)[1];
  assert.ok(y(down, 'B') > y(down, 'A')); assert.equal(y(right, 'A'), y(right, 'B'));
  assert.equal(D.render('# only a comment'), ''); assert.equal(D.render(''), '');
});

test('flow diagrams: a colon inside a node is text, after the last arrow it is the label; same name is one node', () => {
  assert.deepEqual(texts(D.render('A -> (Step 1: go): why')).sort(), ['A', 'Step 1: go', 'why']);
  assert.deepEqual(texts(D.render('A -> {Ok?}: yes')).sort(), ['A', 'Ok?', 'yes']);
  assert.equal((D.render('A -> B\nB -> C\nA -> C').match(/<rect /g) || []).length, 3);
  assert.equal(D.colorOf('nope'), null); assert.equal(D.colorOf('ABC'), '#ABC'); assert.equal(D.colorOf('red'), '#c0392b');
  assert.doesNotMatch(D.render('A #zzzzzz -> B'), /zzzzzz/);       // unknown colours are ignored, never emitted
});

test('sequence diagrams: lifelines, ordered messages, dashed replies, self messages', () => {
  const s = D.render('sequence\ntitle: Login\nBrowser -> Server: POST /login\nServer --> Browser: 200\nServer -> Server: audit');
  assert.match(s, /aria-label="Diagram \(sequence\): Login"/);
  assert.equal((s.match(/<rect /g) || []).length, 2);           // two participants
  assert.equal((s.match(/stroke-dasharray="4 4"/g) || []).length, 2);   // lifelines
  assert.equal((s.match(/stroke-dasharray="6 4"/g) || []).length, 1);   // the reply
  assert.equal((s.match(/marker-end/g) || []).length, 3);
  assert.equal(D.render('title: Login\nsequence\nA -> B: hi'), D.render('sequence\ntitle: Login\nA -> B: hi'));   // either order
  const order = texts(s); assert.ok(order.indexOf('POST /login') < order.indexOf('200') && order.indexOf('200') < order.indexOf('audit'));
});

test('diagram text is escaped and md fences use the new engine', () => {
  assert.doesNotMatch(D.render('<img onerror=x> -> B: <b>hi</b>'), /<img|<b>/);
  assert.doesNotMatch(D.render('sequence\n<script> -> B: "x"'), /<script>/);
  const { md } = MD.create({ resolve: () => null, embed: () => '' });
  assert.match(md('```diagram\nsequence\nA -> B: hi\n```'), /<div class="diagram-wrap"><svg class="diagram"[^>]*Diagram \(sequence\)/);
  assert.match(md('```flow\n(A) -> B\n```'), /<div class="diagram-wrap">/);
});

test('PNG export draws a real image with theme colours resolved', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-dg-')), page = path.join(dir, 't.html');
  const svg = D.render('A -> B #blue').replace(/<\/svg>$/, '<circle r="2" fill="var(--bg,#fff)"/></svg>');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><script src="file://${path.join(__dirname, '..', 'public', 'diagram.js')}"></script>
<body style="color:#336699;--bg:#112233">${svg}<pre id="o">pending</pre><script>
const el = document.querySelector('svg'), s = PNDiagram.standalone(el, '#336699', '#112233');
PNDiagram.toPngBlob(el, '#336699', '#112233', 2).then(async (b) => {
  const u = new Uint8Array(await b.arrayBuffer());
  document.getElementById('o').textContent = JSON.stringify({ png: Array.from(u.slice(0, 8)), size: b.size, color: /color="#336699"/.test(s.svg), cssvar: /var\\(--bg/.test(s.svg), w: s.w });
}).catch((e) => { document.getElementById('o').textContent = 'ERR ' + e.message; });</script>`);
  const out = execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', `--user-data-dir=${path.join(dir, 'p')}`, '--virtual-time-budget=5000', '--dump-dom', 'file://' + page], { encoding: 'utf8', timeout: 60000 });
  const r = JSON.parse(out.match(/<pre id="o">([\s\S]*?)<\/pre>/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(r.png, [137, 80, 78, 71, 13, 10, 26, 10]);        // PNG signature
  assert.ok(r.size > 500); assert.equal(r.color, true); assert.equal(r.cssvar, false); assert.ok(r.w > 100);
});
