const test = require('node:test');
const assert = require('node:assert/strict');
const MD = require('../public/md.js');

const names = new Set(['Home', 'a/Deep']);
const { md } = MD.create({ resolve: (t) => (names.has(t.trim()) ? t.trim() : t.trim() === 'deep' ? 'a/Deep' : null) });

test('escapes raw HTML', () => {
  assert.ok(!md('<script>alert(1)</script>').includes('<script>'));
  assert.ok(md('x <img src=x onerror=alert(1)>').includes('&lt;img'));
});

test('headings, emphasis, inline code', () => {
  const h = md('# Title\n\n**b** *i* ~~s~~ `c*d*`');
  assert.match(h, /<h1>Title<\/h1>/);
  assert.match(h, /<b>b<\/b> <i>i<\/i> <s>s<\/s> <code>c\*d\*<\/code>/);
});

test('wikilinks resolve, alias and mark missing notes', () => {
  assert.match(md('[[Home]]'), /data-note="Home" class="">Home/);
  assert.match(md('[[deep]]'), /data-note="a\/Deep"/);
  assert.match(md('[[Nope|shown]]'), /data-note="Nope" class="new">shown/);
});

test('tables: alignment, escaped pipes, wikilink pipe, ragged rows', () => {
  const h = md('| A | B |\n|:--|--:|\n| [[Home|x]] | `1|2` |\n| only |');
  assert.match(h, /<th style="text-align:left">A<\/th><th style="text-align:right">B<\/th>/);
  assert.match(h, /data-note="Home"[^>]*>x<\/a><\/td>/);
  assert.match(h, /<code>1\|2<\/code>/);
  assert.match(h, /<td style="text-align:left">only<\/td><td style="text-align:right"><\/td>/);
  assert.deepEqual(MD.splitRow('a \\| b | c'), ['a | b', 'c']);
});

test('images: remote, local with spaces, blocks dangerous schemes', () => {
  assert.match(md('![r](https://e.com/x.png)'), /<img src="https:\/\/e.com\/x.png"/);
  assert.match(md('![p](attachments/a b.png)'), /src="\/files\/attachments\/a%20b.png"/);
  assert.ok(!md('![x](javascript:alert(1))').includes('<img'));
  assert.ok(!md('![x](data:text/html;base64,AAA)').includes('<img'));
  assert.ok(!md('![x](%E0%A4%A)').includes('<img'));            // malformed escape must not throw
});

test('links only allow http(s)/mailto', () => {
  assert.match(md('[a](https://e.com)'), /<a href="https:\/\/e.com" target="_blank" rel="noopener">a<\/a>/);
  assert.ok(!md('[a](javascript:alert(1))').includes('href="javascript'));
});

test('lists and tasks', () => {
  const h = md('- one\n- [x] done\n- [ ] todo\n\n1. a\n2. b');
  assert.match(h, /<ul>[\s\S]*checked[\s\S]*<\/ul>/);
  assert.match(h, /<ol>\n<li>a<\/li>\n<li>b<\/li>\n<\/ol>/);
});

test('tags', () => {
  assert.deepEqual([...MD.tagsOf('hi #Idea and #a/b, # not, #123, `#code`\n```\n#fenced\n```')].sort(), ['a/b', 'idea']);
  assert.match(md('x #tag'), /data-tag="tag"/);
});

test('code fences are highlighted and escaped', () => {
  const h = md('```js\nconst a = "x<y>"; // hi\n```');
  assert.match(h, /tk-k">const/);
  assert.match(h, /tk-s">&quot;x&lt;y&gt;&quot;/);
  assert.match(h, /tk-c">\/\/ hi/);
  assert.match(MD.highlight('x = 1 # c', 'py'), /tk-c"># c/);
});

test('listEnter continues, numbers, tasks and ends lists', () => {
  assert.deepEqual(MD.listEnter('- a', 3), { start: 3, end: 3, insert: '\n- ', selStart: 6, selEnd: 6 });
  assert.equal(MD.listEnter('9. a', 4).insert, '\n10. ');
  assert.equal(MD.listEnter('  - [x] a', 9).insert, '\n  - [ ] ');
  assert.deepEqual(MD.listEnter('x\n- ', 4), { start: 2, end: 4, insert: '', selStart: 2, selEnd: 2 });
  assert.equal(MD.listEnter('plain', 5), null);
  assert.equal(MD.listEnter('- a', 1), null);                 // caret inside the marker
});

test('indentLines indents and outdents the selected lines', () => {
  assert.equal(MD.indentLines('a\nb\nc', 0, 3, false).insert, '  a\n  b');
  assert.equal(MD.indentLines('  a\n b', 0, 6, true).insert, 'a\nb');
  assert.equal(MD.indentLines('a', 0, 0, true).insert, 'a');
});

test('wrap toggles markers', () => {
  assert.equal(MD.wrap('hi', 0, 2, '**').insert, '**hi**');
  const u = MD.wrap('**hi**', 2, 4, '**');
  assert.equal(u.insert, 'hi'); assert.equal(u.start, 0); assert.equal(u.end, 6);
});

test('wikiContext detects an open [[', () => {
  assert.deepEqual(MD.wikiContext('see [[Ho', 8), { query: 'Ho', start: 6 });
  assert.equal(MD.wikiContext('see [[Home]] x', 14), null);
  assert.equal(MD.wikiContext('plain', 5), null);
});

test('highlightMarkdown never changes the text (required for the editor overlay)', () => {
  const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const samples = [
    '', '\n', 'plain', '# H1 **b** #tag\n\n- [x] done [[Home|x]]\n  1. n `c` ~~s~~\n> quote *i*\n---',
    '| a | b |\n|---|--:|\n| `1|2` | [[x|y]] |', '```js\nconst a = "<b>" // hi\n/* multi\nline */\n```\nafter', '```\nunclosed <script>',
    '```js\n```', '*not closed **bold', 'a & b < c > d "q"', '![i](a b.png) [l](https://e.com) #1 #a/b_c',
    'tabs\tand  spaces   \n\n\n  indented', '\u00e9\u4e2d\ud83d\ude00 emoji',
  ];
  for (const t of samples) assert.equal(strip(MD.highlightMarkdown(t)), t, JSON.stringify(t));
});

test('highlightMarkdown marks the main constructs', () => {
  const h = MD.highlightMarkdown('# Title\n- item **b** [[Home]] #tag `c`\n> q\n```js\nconst x = 1\n```');
  for (const c of ['mk-h', 'mk-m', 'mk-b', 'mk-l', 'mk-t', 'mk-c', 'mk-q', 'tk-k', 'tk-n']) assert.ok(h.includes(c), c);
  assert.ok(!MD.highlightMarkdown('<script>alert(1)</script>').includes('<script>'));
});

test('slash menu: context only at the start of a line', () => {
  assert.deepEqual(MD.slashContext('/', 1), { query: '', start: 0 });
  assert.deepEqual(MD.slashContext('hello\n  /ta', 11), { query: 'ta', start: 8 });
  assert.equal(MD.slashContext('see /usr', 8), null, 'mid-line slash is ignored');
  assert.equal(MD.slashContext('a/b', 3), null);
  assert.equal(MD.slashContext('/a b', 4), null, 'a space ends the command');
});

test('slash menu: filtering and block insertion data', () => {
  const when = new Date(2026, 10, 1);
  assert.ok(MD.slashItems('', when).length >= 10);
  assert.deepEqual(MD.slashItems('tab', when).map((i) => i.label), ['Table']);
  assert.deepEqual(MD.slashItems('head', when).map((i) => i.label), ['Heading 1', 'Heading 2', 'Heading 3']);
  assert.equal(MD.slashItems('usr', when).length, 0);
  assert.equal(MD.slashItems('date', when)[0].text, '2026-11-01');
  const code = MD.slashItems('code', when)[0];
  assert.equal(code.text.slice(0, code.caret + 1), '```\n\n', 'caret sits between the fences');
  const t = MD.slashItems('table', when)[0];
  assert.equal(t.text.slice(t.caret - 2, t.caret), '| ', 'caret sits in the first empty cell');
});

test('templates fill date, time and title placeholders', () => {
  const when = new Date(2026, 10, 1, 9, 5);
  assert.equal(MD.fillTemplate('# {{title}}\n{{date}} {{ TIME }}\n{{datetime}} {{other}}', 'Standup', when), '# Standup\n2026-11-01 09:05\n2026-11-01 09:05 {{other}}');
  assert.equal(MD.fillTemplate('no placeholders', 'x', when), 'no placeholders');
});

test('find in note: case-insensitive literal matches', () => {
  assert.deepEqual(MD.findAll('Foo foo FOO', 'foo'), [{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }]);
  assert.deepEqual(MD.findAll('a.b a.b', 'a.b').length, 2, 'regex characters are literal');
  assert.deepEqual(MD.findAll('axb', 'a.b'), []);
  assert.deepEqual(MD.findAll('text', ''), []);
  assert.deepEqual(MD.findAll('[x] (y)', '[x]'), [{ start: 0, end: 3 }]);
});

test('callouts, highlights and footnotes', () => {
  const c = md('> [!warning] Careful\n> be **kind**');
  assert.match(c, /class="callout callout-warning"><div class="callout-title">Careful<\/div><div>be <b>kind<\/b>/);
  assert.match(md('> [!note]\n'), /callout-title">Note</);
  assert.match(md('> a\n> b'), /<blockquote>a<br>b<\/blockquote>/);
  assert.match(md('x ==hi== y'), /<mark>hi<\/mark>/);
  const f = md('Text[^1]\n\n[^1]: The note');
  assert.match(f, /<sup class="fn"><a href="#fn-1" id="fnr-1">1<\/a><\/sup>/);
  assert.match(f, /<li id="fn-1">The note /);
});

test('unlinkedMentions finds plain mentions but not linked ones', () => {
  const notes = [
    { name: 'Alpha', text: 'self Alpha' },
    { name: 'a', text: 'I met alpha today' },
    { name: 'b', text: 'see [[Alpha]] and Alpha' },
    { name: 'c', text: 'alphabet soup, [[x|Alpha]] no' },
    { name: 'd', text: '```\nAlpha\n```' },
  ];
  const r = MD.unlinkedMentions(notes, 'Alpha');
  assert.deepEqual(r, [{ name: 'a', index: 6 }]);
});

test('frontmatter: parsed, hidden from body, tags feed tagsOf', () => {
  const t = '---\ntitle: "Hi"\ntags: [a, B]\naliases:\n  - x\n  - y\n---\nBody #inline';
  const fm = MD.frontmatter(t);
  assert.deepEqual(fm.data, { title: 'Hi', tags: ['a', 'B'], aliases: ['x', 'y'] });
  assert.equal(fm.body, 'Body #inline');
  assert.deepEqual([...MD.tagsOf(t)].sort(), ['a', 'b', 'inline']);
  assert.equal(MD.frontmatter('no\n---\nfm').body, 'no\n---\nfm');
  const h = md(t);
  assert.match(h, /class="fm"/); assert.match(h, /data-tag="b"/); assert.ok(!h.includes('title: '));
});

test('section and embeds', () => {
  const doc = '# A\nintro\n## B\nbee\n### B2\nsub\n## C\nsea';
  assert.equal(MD.section(doc, 'b'), '## B\nbee\n### B2\nsub');
  assert.equal(MD.section(doc, 'nope'), null);
  const notes = { Home: '# Home\nhello **there**', Self: '![[Self]]\nx' };
  const e = MD.create({ resolve: (t) => (notes[t.trim()] ? t.trim() : null), embed: (n, h) => (h ? MD.section(notes[n], h) : notes[n]) }).md;
  assert.match(e('![[Home]]'), /class="embed"><div class="embed-title"><a href="#" data-note="Home">Home<\/a><\/div><h1>Home<\/h1>\n<p>hello <b>there<\/b>/);
  assert.match(e('![[Home#Home]]'), /Home › Home/);
  assert.match(e('![[Missing]]'), /class="new"/);
  assert.ok(e('![[Self]]').length < 2000, 'self-embed stops recursing');
});

test('tasksOf ignores fenced code', () => {
  assert.deepEqual(MD.tasksOf('- [ ] a\n```\n- [ ] no\n```\n  1. [x] b'), [{ line: 0, done: false, text: 'a' }, { line: 4, done: true, text: 'b' }]);
});

test('replaceAll is literal, case-insensitive and counts', () => {
  assert.deepEqual(MD.replaceAll('Foo foo FOO a.b', 'foo', 'x'), { text: 'x x x a.b', count: 3 });
  assert.deepEqual(MD.replaceAll('a.b axb', 'a.b', '$&'), { text: '$& axb', count: 1 });
  assert.deepEqual(MD.replaceAll('none', 'zzz', 'q'), { text: 'none', count: 0 });
});

test('link targets: heading, block and plain', () => {
  assert.deepEqual(MD.splitTarget('Note#Head'), { name: 'Note', heading: 'Head', block: '' });
  assert.deepEqual(MD.splitTarget('Note^abc-1'), { name: 'Note', heading: '', block: 'abc-1' });
  assert.deepEqual(MD.splitTarget('#Only'), { name: '', heading: 'Only', block: '' });
  assert.deepEqual(MD.splitTarget('Plain'), { name: 'Plain', heading: '', block: '' });
});

test('heading and block links render with anchors; block ids are marked', () => {
  const h = md('see [[Home#Setup]] and [[Home^x1]] and [[Home#Setup|the setup]] and [[Nope#Heading]]');
  assert.match(h, /<a href="#" data-note="Home" data-anchor="Setup" class="">Home › Setup<\/a>/);
  assert.match(h, /data-note="Home" data-block="x1"/);
  assert.match(h, />the setup<\/a>/);
  assert.match(h, /data-note="Nope#Heading" class="new"/, 'unknown notes stay new-note links');
  assert.match(md('a paragraph ^x1'), /<span class="blk" data-blk="x1"><\/span>/);
  assert.ok(!md('2^3 is eight').includes('class="blk"'), 'a caret inside a sentence is not a block id');
});

test('aliases come from frontmatter', () => {
  assert.deepEqual(MD.aliasesOf('---\naliases: [Big, Large One]\n---\nbody'), ['Big', 'Large One']);
  assert.deepEqual(MD.aliasesOf('---\nalias: a, b\n---\n'), ['a', 'b']);
  assert.deepEqual(MD.aliasesOf('---\naliases:\n  - X\n  - Y\n---\n'), ['X', 'Y']);
  assert.deepEqual(MD.aliasesOf('no frontmatter'), []);
});

test('search query language', () => {
  const q = (s, name, text) => MD.searchMatch(MD.parseQuery(s), name, text);
  assert.equal(q('foo bar', 'n', 'bar and Foo'), true, 'words are ANDed, case-insensitive');
  assert.equal(q('foo bar', 'n', 'only foo'), false);
  assert.equal(q('"foo bar"', 'n', 'foo  bar'), false, 'phrases are exact');
  assert.equal(q('"foo bar"', 'n', 'a foo bar b'), true);
  assert.equal(q('tag:idea', 'n', 'x #idea y'), true);
  assert.equal(q('tag:idea', 'n', 'x #ideas y'), false, 'tags match whole names');
  assert.equal(q('tag:project', 'n', 'x #project/alpha'), true, 'and their children');
  assert.equal(q('path:work/', 'work/plan', 'x'), true);
  assert.equal(q('path:work/', 'home/plan', 'x'), false);
  assert.equal(q('file:plan', 'work/plan', 'x'), true);
  assert.equal(q('file:work', 'work/plan', 'x'), false, 'file: looks at the last path segment only');
  assert.equal(q('-draft', 'n', 'a draft'), false);
  assert.equal(q('-draft foo', 'n', 'foo final'), true);
  assert.equal(q('/fo+\\d/', 'n', 'xx fooo9'), true);
  assert.equal(q('/fo+\\d/', 'n', 'xx foo'), false);
  assert.equal(q('/(/', 'n', 'x'), true, 'a broken regex is ignored, not fatal');
  assert.equal(MD.emptyQuery(MD.parseQuery('  ')), true);
  assert.equal(MD.searchSnippetAt(MD.parseQuery('zebra'), 'a big Zebra here'), 6);
  assert.equal(MD.searchSnippetAt(MD.parseQuery('tag:x'), 'abc'), -1);
});
