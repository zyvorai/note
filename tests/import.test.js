// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I = require('../public/import.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));

// A tiny zip writer so the reader is tested against real archives (deflate or stored; `lie` fakes the declared size).
function makeZip(entries) {
  const parts = [], cd = []; let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? ''), name = Buffer.from(e.name), method = e.store ? 0 : 8, comp = method ? zlib.deflateRawSync(raw) : raw, usize = e.lie ?? raw.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(usize, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(lh, name, comp); cd.push(c, name); off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, end]));
}
const F = (p, d) => ({ path: p, data: new Uint8Array(Buffer.from(d)) });
const noteMap = (r) => Object.fromEntries(r.map((n) => [n.name, n.text]));

test('md5 matches the real thing (Evernote attachments are matched by it)', () => {
  for (const n of [0, 1, 55, 56, 64, 65, 1000]) { const u = new Uint8Array(n).map((_, i) => (i * 7 + n) & 255); assert.equal(I.md5(u), crypto.createHash('md5').update(u).digest('hex')); }
});

test('zip reader: deflate and stored, nested zips, hostile paths, bombs and damage', async () => {
  const inner = makeZip([{ name: 'Vault/Part/Inner.md', data: '# inner' }]);
  const z = makeZip([{ name: 'Vault/a.md', data: 'A'.repeat(5000) }, { name: 'Vault/b.md', data: 'bee', store: true }, { name: 'Vault/dir/', data: '' }, { name: 'Vault/sub.zip', data: inner, store: true },
    { name: '../evil.md', data: 'x' }, { name: 'Vault/../../evil2.md', data: 'x' }, { name: 'C:/win.md', data: 'x' }, { name: '__MACOSX/Vault/._a.md', data: 'x' }, { name: 'Vault/.obsidian/app.json', data: '{}' }]);
  const { files, warnings } = await I.prepare([{ path: 'export.zip', data: z }]);
  const names = files.map((f) => f.path);
  assert.deepEqual([...names].sort(), ['Part/Inner.md', 'a.md', 'b.md']);                          // wrapper folder stripped, hostile and hidden entries gone
  for (const want of ['a.md', 'b.md', 'Part/Inner.md']) assert.ok(names.includes(want), want);
  for (const bad of ['evil.md', 'evil2.md', 'win.md', '._a.md', 'app.json']) assert.ok(!names.some((n) => n.endsWith(bad)), 'dropped ' + bad);
  assert.equal(Buffer.from(files.find((f) => f.path === 'a.md').data).toString(), 'A'.repeat(5000));
  assert.ok(warnings.length >= 2);                                                                 // the two ".." paths were reported
  assert.equal(I.cleanPath('/abs.md'), 'abs.md'); assert.equal(I.cleanPath('a/../b'), null); assert.equal(I.cleanPath('x/.hidden/y'), ''); assert.equal(I.cleanPath('a\\b.md'), 'a/b.md');
  await assert.rejects(I.readZip(makeZip([{ name: 'bomb.md', data: Buffer.alloc(3e6), lie: 10 }])), /too large/);   // declared 10 bytes, inflates to 3 MB
  await assert.rejects(I.readZip(new Uint8Array(50)), /zip/i);
  const dmg = Buffer.from(makeZip([{ name: 'a.md', data: 'x' }])); dmg.writeUInt32LE(0x1234, dmg.indexOf(Buffer.from([0x50, 0x4b, 1, 2])));
  await assert.rejects(I.readZip(new Uint8Array(dmg)), /damaged/);
});

test('Notion export: ids removed, nested pages, links and images rewritten, CSV tables', async () => {
  const id1 = 'a'.repeat(32), id2 = 'b'.repeat(32), id3 = 'c'.repeat(32);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const files = (await I.prepare([{ path: 'export.zip', data: makeZip([
    { name: `Export/Project Plan ${id1}.md`, data: `# Project Plan\n\nSee [Design Notes](Project%20Plan%20${id1}/Design%20Notes%20${id2}.md) and [site](https://example.com) and ![shot](Project%20Plan%20${id1}/shot.png).\n\n\`\`\`\n[x](Design%20Notes%20${id2}.md)\n\`\`\`\n` },
    { name: `Export/Project Plan ${id1}/Design Notes ${id2}.md`, data: `# Design Notes\n\nBack to [the plan](../Project%20Plan%20${id1}.md) and [gone](Missing%20${id3}.md).` },
    { name: `Export/Project Plan ${id1}/shot.png`, data: png, store: true },
    { name: `Export/Tasks ${id3}.csv`, data: 'Name,Notes\n"Write, ship","two\nlines"\nPipe,a|b\n' }, { name: `Export/Tasks ${id3}_all.csv`, data: 'dup' },
    { name: 'Export/clip.docx', data: 'x' }, { name: 'Export/song.mp3', data: 'x' }, { name: 'Export/song2.mp3', data: 'x' },
  ]) }])).files;
  const plan = I.plan(files, { existing: new Set(['project plan']), prefix: 'Imported' });
  assert.deepEqual(plan.notes.map((n) => n.name).sort(), ['Imported/Project Plan', 'Imported/Project Plan/Design Notes', 'Imported/Tasks'].sort());
  assert.equal(plan.attachments.length, 1); assert.equal(plan.stats.csv, 1);
  assert.match(plan.warnings.join('\n'), /Skipped 3 unsupported file\(s\): \.docx × 1, \.mp3 × 2/);
  const out = noteMap(I.finalize(plan, new Map([[plan.attachments[0].from, 'attachments/123-shot.png']])));
  const main = out['Imported/Project Plan'];
  assert.match(main, /See \[\[Imported\/Project Plan\/Design Notes\]\] and/);       // link text equal to the note name needs no alias assert.match(main, /\[site\]\(https:\/\/example\.com\)/);
  assert.match(main, /!\[shot\]\(attachments\/123-shot\.png\)/); assert.match(main, /```\n\[x\]\(Design%20Notes%20b{32}\.md\)\n```/);   // untouched inside a code fence
  assert.match(out['Imported/Project Plan/Design Notes'], /\[\[Imported\/Project Plan\|the plan\]\]/); assert.match(out['Imported/Project Plan/Design Notes'], /\[gone\]\(Missing/);   // unresolved link left alone
  assert.equal(out['Imported/Tasks'], '# Tasks\n\n| Name | Notes |\n| --- | --- |\n| Write, ship | two lines |\n| Pipe | a\\|b |\n');
  assert.equal(plan.stats.links, 3);
  const clash = I.plan(files, { existing: new Set(['imported/project plan']), prefix: 'Imported' });    // existing notes are never overwritten
  assert.ok(clash.notes.some((n) => n.name === 'Imported/Project Plan 2'));
});

test('Obsidian vault and Bear textbundles', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const { files } = await I.prepare([F('Vault/.obsidian/app.json', '{}'), F('Vault/Daily/2026-01-01.md', 'Log [[Ideas/Big idea|the big one]] ![[pic.png]] [[doc.pdf]] [[Plain]] ![[Embedded]] `[[Ideas/Big idea]]`'),
    F('Vault/Ideas/Big idea.md', '---\ntags: x\n---\nbody'), F('Vault/Plain.md', 'p'), F('Vault/Embedded.md', 'e'), { path: 'Vault/files/pic.png', data: png }, F('Vault/files/doc.pdf', '%PDF'), F('Vault/board.canvas', '{}')]);
  const plan = I.plan(files, { prefix: 'Imported' });
  assert.deepEqual(plan.notes.map((n) => n.name).sort(), ['Imported/Daily/2026-01-01', 'Imported/Embedded', 'Imported/Ideas/Big idea', 'Imported/Plain']);
  assert.match(plan.warnings.join(), /\.canvas × 1/);
  const up = new Map(plan.attachments.map((a, i) => [a.from, `attachments/${i}-${a.name}`])), out = noteMap(I.finalize(plan, up));
  const daily = out['Imported/Daily/2026-01-01'];
  assert.match(daily, /\[\[Imported\/Ideas\/Big idea\|the big one\]\]/);           // path-style wikilinks follow the prefix
  assert.match(daily, /!\[\]\(attachments\/\d-pic\.png\)/); assert.match(daily, /\[doc\.pdf\]\(attachments\/\d-doc\.pdf\)/);   // attachment embeds by name
  assert.match(daily, /\[\[Plain\]\] !\[\[Embedded\]\] `\[\[Ideas\/Big idea\]\]`/);   // note links/embeds and code left as they are
  assert.equal(out['Imported/Ideas/Big idea'], '---\ntags: x\n---\nbody');
  assert.ok(!I.plan(files, {}).notes.some((n) => n.name.startsWith('Imported')));   // no prefix when merging
  const bear = I.plan((await I.prepare([F('My Note.textbundle/text.md', '# My Note\n![](assets/x.png)'), { path: 'My Note.textbundle/assets/x.png', data: png }, F('Other.textbundle/text.markdown', 'o')])).files, {});
  assert.deepEqual(bear.notes.map((n) => n.name).sort(), ['My Note', 'Other']);       // a textbundle is named after its folder, not "text"
  assert.match(noteMap(I.finalize(bear, new Map([[bear.attachments[0].from, 'attachments/9-x.png']])))['My Note'], /!\[\]\(attachments\/9-x\.png\)/);
});

test('HTML and Evernote need the in-app importer when no converter is available', async () => {
  const { files } = await I.prepare([F('a.html', '<p>x</p>'), F('Notebook.enex', '<en-export/>'), F('n.md', 'n')]);
  const plan = I.plan(files, {});
  assert.equal(plan.notes.length, 1); assert.equal(plan.warnings.filter((w) => /in-app importer/.test(w)).length, 2);
});

test('Evernote .enex and Notion HTML convert in a real browser', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), hash = crypto.createHash('md5').update(png).digest('hex');
  const enex = `<?xml version="1.0"?><en-export><note><title>Trip &amp; plans</title><content><![CDATA[<?xml version="1.0"?><en-note><div>Pack <b>light</b></div><div><en-todo checked="true"/>Passport</div><div><en-todo/>Tickets</div><div><en-media hash="${hash}" type="image/png"/>Caption after</div><div><a href="https://example.com/x">link</a></div></en-note>]]></content><created>20240305T101500Z</created><updated>20240306T000000Z</updated><tag>travel</tag><tag>to do</tag><resource><data encoding="base64">${png.toString('base64')}</data><mime>image/png</mime><resource-attributes><file-name>map.png</file-name></resource-attributes></resource></note><note><title>Second</title><content><![CDATA[<en-note>plain</en-note>]]></content></note></en-export>`;
  const notionHtml = '<html><body><nav>menu</nav><article><h1>Page</h1><p>See <a href="Other%20' + 'd'.repeat(32) + '.html">other</a></p></article></body></html>';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-imp-')), page = path.join(dir, 't.html'), pub = path.join(__dirname, '..', 'public');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><script src="file://${pub}/clip.js"></script><script src="file://${pub}/import.js"></script><pre id="o">pending</pre><script>
(async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const { files } = await PNImport.prepare([{ path: 'My Notebook.enex', data: enc(${JSON.stringify(enex)}) }, { path: 'Other ${'d'.repeat(32)}.html', data: enc('<article><h1>Other</h1></article>') }, { path: 'Page ${'e'.repeat(32)}.html', data: enc(${JSON.stringify(notionHtml)}) }]);
  const plan = PNImport.plan(files, { prefix: 'Imported', html2md: PNClip.clip });
  const up = new Map(plan.attachments.map((a) => [a.from, 'attachments/1-' + a.name]));
  document.getElementById('o').textContent = JSON.stringify({ notes: PNImport.finalize(plan, up), atts: plan.attachments.map((a) => [a.from, a.name, a.data.length]), warnings: plan.warnings, stats: plan.stats });
})().catch((e) => { document.getElementById('o').textContent = 'ERR ' + e.stack; });</script>`);
  const out = execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', `--user-data-dir=${path.join(dir, 'p')}`, '--virtual-time-budget=5000', '--dump-dom', 'file://' + page], { encoding: 'utf8', timeout: 60000 });
  const raw = out.match(/<pre id="o">([\s\S]*?)<\/pre>/)[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.ok(!raw.startsWith('ERR'), raw);
  const r = JSON.parse(raw), by = noteMap(r.notes);
  const trip = by['Imported/My Notebook/Trip & plans'];
  assert.match(trip, /^---\ncreated: 2024-03-05\nupdated: 2024-03-06\ntags: travel to-do\n---\n\n# Trip & plans\n/);
  assert.match(trip, /Pack \*\*light\*\*/); assert.match(trip, /- \[x\] Passport/); assert.match(trip, /- \[ \] Tickets/);
  assert.match(trip, /!\[map\]\(attachments\/1-map\.png\)/);                         // matched to its resource by md5 and rewritten to the saved path
  assert.match(trip, /Caption after/);                                               // text following a self-closed tag survives
  assert.match(trip, /\[link\]\(https:\/\/example\.com\/x\)/);
  assert.deepEqual(r.atts, [[`enres:${hash}`, 'map.png', 16]]);
  assert.equal(by['Imported/My Notebook/Second'], '# Second\n\nplain\n');
  assert.match(by['Imported/Page'], /^# Page\n\nSee \[\[Imported\/Other\|other\]\]/); assert.ok(!by['Imported/Page'].includes('menu'));   // Notion HTML page links resolve
  assert.equal(r.stats.enex, 1); assert.equal(r.stats.html, 2);
});

test('CLI import: folder and zip, prefix, attachments, and a second run never overwrites', () => {
  const run = (...a) => execFileSync(process.execPath, [path.join(__dirname, '..', 'server.js'), 'import', ...a], { encoding: 'utf8' });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-cli-src-')), notes = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-cli-notes-'));
  fs.mkdirSync(path.join(src, 'Vault', 'img'), { recursive: true }); fs.mkdirSync(path.join(src, 'Vault', '.obsidian'));
  fs.writeFileSync(path.join(src, 'Vault', 'A.md'), 'See [[B]] and ![[p.png]] and [[sub/B|bee]]'); fs.mkdirSync(path.join(src, 'Vault', 'sub')); fs.writeFileSync(path.join(src, 'Vault', 'sub', 'B.md'), 'b');
  fs.writeFileSync(path.join(src, 'Vault', 'img', 'p.png'), Buffer.from('89504e470d0a1a0a', 'hex')); fs.writeFileSync(path.join(src, 'Vault', '.obsidian', 'x.json'), '{}');
  fs.writeFileSync(path.join(notes, 'Mine.md'), 'mine');
  const o1 = run(src, notes);
  assert.match(o1, /Imported 2 notes, 1 attachment, 2 links fixed/);
  assert.equal(fs.readFileSync(path.join(notes, 'Mine.md'), 'utf8'), 'mine');
  const a = fs.readFileSync(path.join(notes, 'Imported', 'A.md'), 'utf8');
  assert.match(a, /\[\[Imported\/sub\/B\|bee\]\]/); const img = /!\[\]\((attachments\/[^)]+\.png)\)/.exec(a); assert.ok(img && fs.existsSync(path.join(notes, img[1])));
  assert.ok(!fs.existsSync(path.join(notes, 'Imported', '.obsidian')));
  run(src, notes);                                                         // again: nothing is overwritten, names are numbered
  assert.ok(fs.existsSync(path.join(notes, 'Imported', 'A 2.md'))); assert.equal(fs.readFileSync(path.join(notes, 'Imported', 'A.md'), 'utf8'), a);
  const zipPath = path.join(src, 'v.zip'); fs.writeFileSync(zipPath, makeZip([{ name: 'Z/One.md', data: 'one' }]));
  run(zipPath, notes, '--merge'); assert.equal(fs.readFileSync(path.join(notes, 'One.md'), 'utf8'), 'one');
  assert.throws(() => run(src, src), /separate folders/); assert.throws(() => run('/no/such/thing', notes), /does not exist/);
});
