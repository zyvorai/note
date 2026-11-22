// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const mk = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));
const crc32 = (b) => { let c = ~0 >>> 0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return ~c >>> 0; };
const cli = (...a) => spawnSync(process.execPath, [SERVER, ...a], { encoding: 'utf8' });

async function start(dir = mk('pn-bk-'), env = {}) {
  const port = await free();
  const proc = spawn(process.execPath, [SERVER, dir, String(port)], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Open:/.test(d) && res()); proc.on('exit', rej); });
  const base = `http://127.0.0.1:${port}`;
  return { dir, base, stop: () => proc.kill() };
}
// A zip writer that lets a test lie about sizes and checksums, to build hostile archives.
function zip(entries) {
  const parts = [], cd = []; let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? ''), name = Buffer.from(e.name), method = e.store ? 0 : 8, comp = method ? zlib.deflateRawSync(raw) : raw;
    const usize = e.usize ?? raw.length, crc = e.crc ?? crc32(raw), t = e.time ?? 0, d = e.date ?? ((2024 - 1980) << 9 | 3 << 5 | 5);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(t, 10); lh.writeUInt16LE(d, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(method, 10); c.writeUInt16LE(t, 12); c.writeUInt16LE(d, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(usize, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(lh, name, comp); cd.push(c, name); off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
// Reads a zip's central directory (independent of the server's reader) -> { name: Buffer }
function readZip(buf) {
  let e = buf.length - 22; while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10), out = {}; let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), cs = buf.readUInt32LE(p + 20), us = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl), ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(ds, ds + cs);
    const data = method ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, us, name + ' size'); assert.equal(crc32(data), crc, name + ' crc'); out[name] = data; p += 46 + nl + el + cl;
  }
  return out;
}
function seed(dir) {
  const w = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
  w('One.md', '# One\nhello ✓'); w('sub/Zwei Ü.md', 'two'); w('attachments/pic.png', crypto.randomBytes(150000)); w('attachments/doc.pdf', '%PDF-1.4 fake');
  w('.plainnote/snippets/dark.css', 'body{}'); w('.plainnote/history/One/1700000000000.md', 'old one'); w('Secret.md', '-----BEGIN PLAINNOTE ENCRYPTED NOTE-----\nVersion: 1\n\nAAAA\n-----END PLAINNOTE ENCRYPTED NOTE-----\n');
  // things that must never be in a backup
  w('.git/config', 'git'); w('.trash/1__gone.md', 'deleted'); w('.plainnote/token', 'SECRET-TOKEN'); w('notes.docx', 'word'); w('.hidden.md', 'hidden'); w('node_modules/x/y.md', 'nm'); w('.plainnote/other.md', 'o');
  try { fs.symlinkSync(os.tmpdir(), path.join(dir, 'linkdir')); fs.symlinkSync(path.join(dir, 'One.md'), path.join(dir, 'link.md')); } catch {}
}

test('backup: streams a valid zip with exactly the right files, and nothing private', async () => {
  const dir = mk('pn-bk-src-'); seed(dir); const s = await start(dir);
  try {
    const r = await fetch(`${s.base}/api/backup`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip'); assert.match(r.headers.get('content-disposition'), /attachment; filename="plainnote-backup-\d{4}-\d\d-\d\d\.zip"/);
    const buf = Buffer.from(await r.arrayBuffer()), files = readZip(buf);
    assert.deepEqual(Object.keys(files).sort(), ['.plainnote/history/One/1700000000000.md', '.plainnote/snippets/dark.css', 'One.md', 'PLAINNOTE-BACKUP.txt', 'Secret.md', 'attachments/doc.pdf', 'attachments/pic.png', 'sub/Zwei Ü.md']);
    assert.deepEqual(files['attachments/pic.png'], fs.readFileSync(path.join(dir, 'attachments/pic.png'))); assert.equal(files['One.md'].toString(), '# One\nhello ✓');
    assert.ok(!buf.includes('SECRET-TOKEN') && !buf.includes('word') && !buf.includes('deleted'));          // token, docx, trash: not even as bytes
    assert.match(files['PLAINNOTE-BACKUP.txt'].toString(), /^Plainnote backup\nCreated: /);
    const z = path.join(mk('pn-bk-z-'), 'b.zip'); fs.writeFileSync(z, buf);
    const t = spawnSync('unzip', ['-tq', z], { encoding: 'utf8' });                                            // an independent unzip must accept it too (skipped where unzip is absent)
    if (!t.error) { assert.equal(t.status, 0, t.stdout + t.stderr); assert.match(t.stdout, /No errors detected/); }
    assert.equal((await fetch(`${s.base}/api/backup`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);   // another website cannot trigger it
  } finally { s.stop(); }
});

test('restore: dry run reports, apply adds, and a second apply changes nothing', async () => {
  const src = mk('pn-bk-a-'); seed(src); const a = await start(src);
  const dst = mk('pn-bk-b-'), b = await start(dst);
  try {
    const zipBuf = Buffer.from(await (await fetch(`${a.base}/api/backup`)).arrayBuffer());
    const post = (base, mode, body) => fetch(`${base}/api/backup/restore?mode=${mode}`, { method: 'POST', body }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const dry = await post(b.base, 'dry', zipBuf);
    assert.deepEqual({ ...dry.body, errors: dry.body.errors.length }, { files: 7, added: 7, same: 0, copies: 0, skipped: 0, notes: 3, errors: 0 });
    assert.deepEqual(fs.readdirSync(dst), []);                                                                   // a dry run writes nothing
    const run = await post(b.base, 'apply', zipBuf); assert.equal(run.body.added, 7); assert.deepEqual(run.body.errors, []);
    assert.deepEqual(fs.readFileSync(path.join(dst, 'attachments/pic.png')), fs.readFileSync(path.join(src, 'attachments/pic.png')));
    assert.equal(fs.readFileSync(path.join(dst, 'sub/Zwei Ü.md'), 'utf8'), 'two'); assert.ok(fs.existsSync(path.join(dst, '.plainnote/snippets/dark.css')));
    assert.ok(Math.abs(fs.statSync(path.join(dst, 'One.md')).mtimeMs - fs.statSync(path.join(src, 'One.md')).mtimeMs) < 3000);   // modification times come back too
    assert.ok(!fs.existsSync(path.join(dst, '.plainnote/token')) && !fs.existsSync(path.join(dst, 'notes.docx')));
    const again = await post(b.base, 'apply', zipBuf); assert.deepEqual({ added: again.body.added, same: again.body.same, copies: again.body.copies }, { added: 0, same: 7, copies: 0 });
    assert.deepEqual((await (await fetch(`${b.base}/api/notes`)).json()).map((n) => n.name).sort(), ['One', 'Secret', 'sub/Zwei Ü']);   // the app sees them, including the still-encrypted one
  } finally { a.stop(); b.stop(); }
});

test('restore never overwrites: a changed note is kept alongside as a "(restored …)" copy', async () => {
  const src = mk('pn-bk-c-'); seed(src); const bk = path.join(mk('pn-bk-d-'), 'b.zip');
  assert.equal(cli('backup', src, bk).status, 0);
  const dst = mk('pn-bk-e-'); fs.writeFileSync(path.join(dst, 'One.md'), 'my newer edit'); fs.mkdirSync(path.join(dst, 'sub')); fs.writeFileSync(path.join(dst, 'sub/Zwei Ü.md'), 'two');   // one differs, one identical
  const dry = cli('restore', bk, dst, '--dry-run'); assert.match(dry.stdout, /Would restore: 5 new files, 1 already identical, 1 kept as separate/);
  const r = cli('restore', bk, dst); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Restored: 5 new files, 1 already identical, 1 kept as separate/);
  assert.equal(fs.readFileSync(path.join(dst, 'One.md'), 'utf8'), 'my newer edit');                               // untouched
  const copy = fs.readdirSync(dst).find((f) => /^One \(restored \d{4}-\d\d-\d\d\)\.md$/.test(f)); assert.ok(copy);
  assert.equal(fs.readFileSync(path.join(dst, copy), 'utf8'), '# One\nhello ✓');
  assert.match(cli('restore', bk, dst).stdout, /0 new files, 7 already identical, 0 kept as separate/);       // restoring again piles up nothing: the copy made last time counts as already there
  assert.equal(fs.readdirSync(dst).filter((f) => f.startsWith('One (restored')).length, 1);
});

test('restore refuses hostile archives: unsafe paths, wrong types, lying sizes and checksums', async () => {
  const dst = mk('pn-bk-f-'), outside = mk('pn-bk-out-'), s = await start(dst);
  const post = (body, mode = 'apply') => fetch(`${s.base}/api/backup/restore?mode=${mode}`, { method: 'POST', body }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const bomb = Buffer.alloc(3e6, 0x41);
    const evil = zip([
      { name: '../escape.md', data: 'x' }, { name: 'a/../../escape2.md', data: 'x' }, { name: '/abs.md', data: 'abs-ok-leading-slash-is-stripped' }, { name: 'C:/win.md', data: 'x' }, { name: 'back\\slash.md', data: 'x' },
      { name: '.git/config', data: 'x' }, { name: '.plainnote/token', data: 'x' }, { name: '.plainnote/snippets/../x.css', data: 'x' }, { name: 'run.exe', data: 'x' }, { name: 'dir/.hidden.md', data: 'x' },
      { name: 'good/Note.md', data: 'fine' },
      { name: 'bomb.md', data: bomb, usize: 10, crc: crc32(bomb.subarray(0, 10)) },             // declares 10 bytes, inflates to 3 MB
      { name: 'badcrc.md', data: 'content', crc: 12345 }, { name: 'badsize.md', data: 'content', usize: 3 },
    ]);
    const r = await post(evil);
    assert.equal(r.status, 200); assert.equal(r.body.added, 3);                                                  // good/Note.md, abs.md (leading slash stripped) and back/slash.md (a Windows-style separator)
    assert.equal(fs.readFileSync(path.join(dst, 'good/Note.md'), 'utf8'), 'fine'); assert.ok(fs.existsSync(path.join(dst, 'abs.md'))); assert.equal(fs.readFileSync(path.join(dst, 'back/slash.md'), 'utf8'), 'x');
    assert.equal(r.body.errors.length, 3); for (const name of ['bomb.md', 'badcrc.md', 'badsize.md']) assert.ok(r.body.errors.some((e) => e.startsWith(name + ':')), name);
    assert.equal(r.body.skipped, 8);
    for (const f of ['bomb.md', 'badcrc.md', 'badsize.md']) assert.ok(!fs.existsSync(path.join(dst, f)), f + ' must not be left behind');
    assert.deepEqual(fs.readdirSync(dst).filter((f) => /partial/.test(f)), []);                                  // no half-written files either
    assert.ok(!fs.existsSync(path.join(path.dirname(dst), 'escape.md')) && !fs.existsSync(path.join(path.dirname(dst), 'escape2.md')) && !fs.existsSync(path.join(dst, '.plainnote/token')));
    assert.equal((await post(Buffer.from('this is not a zip file at all'))).status, 400);                        // not a zip
    assert.match((await post(Buffer.from('this is not a zip file at all'))).body.error, /not a Plainnote backup/);
    assert.equal((await post(zip([{ name: 'x.md', data: 'x' }]).subarray(0, 40))).status, 400);                 // truncated
    // an existing folder that is really a link to somewhere else must not be written through
    try { fs.symlinkSync(outside, path.join(dst, 'linked')); const l = await post(zip([{ name: 'linked/in.md', data: 'x' }])); assert.equal(l.body.added, 0); assert.deepEqual(fs.readdirSync(outside), []); } catch (e) { if (e.code !== 'EPERM') throw e; }
  } finally { s.stop(); }
});

test('backup command: folder mode keeps only the newest N, refuses to write inside the notes, reports missing folders', () => {
  const src = mk('pn-bk-g-'); seed(src); const out = mk('pn-bk-h-');
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(out, `plainnote-backup-2020-01-0${i + 1}-000000.zip`), 'old');
  const r = cli('backup', src, out + '/', '--keep', '3'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Backed up 7 files/); assert.match(r.stdout, /Removed 2 older backups/);
  const left = fs.readdirSync(out).sort(); assert.equal(left.length, 3); assert.ok(!left.includes('plainnote-backup-2020-01-01-000000.zip') && !left.includes('plainnote-backup-2020-01-02-000000.zip'));
  assert.ok(left.some((f) => !f.startsWith('plainnote-backup-2020')));                                           // the new one is kept
  assert.match(cli('backup', src, path.join(src, 'inside.zip')).stderr, /outside the notes folder/); assert.ok(!fs.existsSync(path.join(src, 'inside.zip')));
  assert.match(cli('backup', '/no/such/folder').stderr, /does not exist/); assert.match(cli('restore', '/no/such.zip', out).stderr, /does not exist/);
  assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.partial')).length, 0);
});

test('save endpoint writes to the Downloads folder only, with a fresh name each time', async () => {
  const src = mk('pn-bk-i-'); seed(src), dl = mk('pn-bk-dl-'); const s = await start(src, { PLAINNOTE_BACKUP_DIR: dl });
  try {
    const save = () => fetch(`${s.base}/api/backup/save`, { method: 'POST', body: JSON.stringify({ path: '/etc/evil' }) }).then((r) => r.json());   // a path from the client is ignored
    const a = await save(), b = await save();
    assert.equal(path.dirname(a.path), dl); assert.notEqual(a.path, b.path); assert.equal(a.files, 7); assert.ok(fs.statSync(a.path).size > 100000);
    assert.equal(fs.readdirSync(dl).length, 2);
    assert.ok(Object.keys(readZip(fs.readFileSync(a.path))).includes('One.md'));
  } finally { s.stop(); }
});
