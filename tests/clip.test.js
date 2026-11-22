// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// The web clipper converts real DOM, so these run the converter in headless Chrome (skipped when it isn't installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));

function run(cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-clip-'));
  const page = path.join(dir, 't.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><script src="${pathToFile(path.join(__dirname, '..', 'public', 'clip.js'))}"></script><pre id="o"></pre><script>
const cases = ${JSON.stringify(cases).replace(/</g, '\\u003c')};
document.getElementById('o').textContent = JSON.stringify(cases.map((c) => PNClip.clip(c.html, 'https://example.com/a/b', c.whole)));
</script>`);
  const out = execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', `--user-data-dir=${path.join(dir, 'p')}`, '--dump-dom', 'file://' + page], { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(out.match(/<pre id="o">([\s\S]*?)<\/pre>/)[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}
const pathToFile = (p) => 'file://' + p;

test('clipper converts page HTML to Markdown', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, () => {
  const [a, b, c, d] = run([
    { whole: true, html: `<nav>Menu</nav><div class="cookie">accept</div><article><h1>Big  Title</h1><p>Hello <strong>bold</strong> and <em>it</em> with <a href="/x?y=1">a link</a> and <code>x = 1</code>.</p>
      <ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol start="3"><li>c</li></ol><blockquote><p>quoted</p></blockquote>
      <pre><code class="language-js">const a = 1;\n  if (a) {}</code></pre><img src="pic.png" alt="A [pic]"><img src="data:image/png;base64,AAAA">
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>x|y</td></tr></table><script>alert(1)</script><style>p{}</style></article><footer>© me</footer>` },
    { whole: true, html: '<body><div class="nav">keep? no</div><p>Only body text</p><a href="javascript:alert(1)">bad</a> <a href="https://e.com/(x)">paren</a></body>' },
    { whole: false, html: '<div class="sidebar">kept because selected</div> <span>plain</span>' },
    { whole: true, html: '<p>a</p><div><div><p>b</p></div></div><hr><p>c   \n  d</p><h2><a href="/h">Head</a></h2>' },
  ]);
  assert.match(a, /^# Big Title\n\nHello \*\*bold\*\* and \*it\* with \[a link\]\(https:\/\/example\.com\/x\?y=1\) and `x = 1`\./);
  assert.match(a, /\n- one\n    - nested\n- two\n/); assert.match(a, /\n3\. c\n/); assert.match(a, /\n> quoted\n/);
  assert.match(a, /```js\nconst a = 1;\n  if \(a\) \{\}\n```/);
  assert.match(a, /!\[A  pic\]\(https:\/\/example\.com\/a\/pic\.png\)/); assert.doesNotMatch(a, /data:image/);
  assert.match(a, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| x\\\|y \|/);
  for (const bad of ['Menu', 'accept', 'alert(1)', '© me', 'p{}']) assert.ok(!a.includes(bad), 'dropped: ' + bad);
  assert.match(b, /^Only body text/); assert.doesNotMatch(b, /keep\? no/); assert.doesNotMatch(b, /javascript:/); assert.match(b, /\[paren\]\(https:\/\/e\.com\/\(x%29\)/);
  assert.match(c, /kept because selected/);                                  // a selection is never filtered
  assert.equal(d, 'a\n\nb\n\n---\n\nc d\n\n## [Head](https://example.com/h)');
});

test('clipper helpers: safe names and note front matter', () => {
  const { safeName, noteText } = require('../public/clip.js');
  assert.equal(safeName('A/B: C? #1 [x]'), 'A B C 1 x'); assert.equal(safeName('///'), 'Untitled clip'); assert.equal(safeName('x'.repeat(200)).length, 80);
  const t = noteText('Hi', 'https://e.com/a?b=1#c', 'body');
  assert.match(t, /^---\nsource: "https:\/\/e\.com\/a\?b=1#c"\nclipped: \d{4}-\d\d-\d\d\ntags: clipping\n---\n\n# Hi\n\nbody\n$/);
  assert.ok(noteText('Hi', 'u', '# Own title\n\nx').includes('\n\n# Own title'));
  assert.ok(!noteText('Hi', 'u', '# Own title\n\nx').includes('# Hi'));
});

test('bookmarklet is valid JavaScript that targets only this server', () => {
  const { bookmarklet } = require('../public/clip.js');
  const url = bookmarklet('http://localhost:4777');
  assert.ok(url.startsWith('javascript:'));
  const code = decodeURIComponent(url.slice('javascript:'.length));
  assert.doesNotThrow(() => new Function(code));
  assert.match(code, /"http:\/\/localhost:4777"/); assert.match(code, /e\.origin===b/); assert.match(code, /w\.postMessage\(m,b\)/);   // origin-checked both ways
});
