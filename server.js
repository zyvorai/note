#!/usr/bin/env node
// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Zero-dependency local notes server. Usage: node server.js [notesDir] [port]
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const PUBLIC = path.resolve(__dirname, 'public');

// UI files come from ./public, or from assets embedded in a single-file executable (see scripts/build-sea.js).
let sea = null;
try { const m = require('node:sea'); if (m.isSea()) sea = m; } catch {}
async function readPublic(rel) {
  if (sea) {
    if (rel.includes('..') || rel.includes('/')) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    try { return Buffer.from(sea.getRawAsset(rel)); } catch { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }
  }
  const f = path.resolve(PUBLIC, rel);
  if (!f.startsWith(PUBLIC + path.sep)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
  return fs.readFile(f);
}

// ---- Backup and restore: a .zip of your notes, written and read without any dependency ----
// A backup holds Plainnote's own data only: notes (*.md), attachments (images, PDFs), custom CSS snippets and version history. It leaves out
// the trash, git data, the remote-access token and anything else. A restore only ever ADDS files: an existing file is never overwritten.
const fsSync = require('fs'), os = require('os'), zlib = require('zlib');
const { pipeline, finished } = require('stream/promises');
const { once } = require('events');
const { Transform, Readable } = require('stream');

const BK_ATTACH = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);
const BK_MAX_FILES = 65535, BK_MAX_BYTES = 0xffffffff, BK_MAX_TOTAL = 20e9;
// What a path inside a backup may be: returns a kind, or null for anything that must not be written or saved.
function backupKind(rel) {
  const parts = String(rel).split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\0') || p.includes('\\') || /^[A-Za-z]:$/.test(p))) return null;
  const base = parts[parts.length - 1], ext = path.extname(base).toLowerCase();
  if (parts[0] === '.plainnote') {
    if (parts[1] === 'snippets' && parts.length === 3 && /^\w[\w .-]*\.css$/.test(base)) return 'snippet';
    if (parts[1] === 'history' && parts.length === 4 && /^\d+\.md$/.test(base) && !parts[2].startsWith('.')) return 'history';
    return null;                                                                   // .plainnote/token and everything else in there stays out
  }
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return null;   // .git, .trash, hidden files
  if (ext === '.md') return 'note';
  return BK_ATTACH.has(ext) ? 'attachment' : null;
}
async function collectBackup(root, rel = '', out = []) {
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;                                              // never follow links out of the folder
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name === '.plainnote' || !e.name.startsWith('.')) await collectBackup(root, r, out); }
    else if (e.isFile() && backupKind(r)) out.push({ name: r, file: path.join(root, r) });
  }
  return out;
}
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf, prev = 0) => { let c = ~prev >>> 0; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
const dosTime = (ms) => { const d = new Date(Math.max(ms, 315532800000)); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; };
const fromDos = (time, date) => new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31 || 1, time >> 11, (time >> 5) & 63, (time & 31) * 2);
const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Streams the zip to `out` (an HTTP response or a file) one file at a time, so memory stays small however large the notes folder is.
async function writeBackup(out, root) {
  const files = await collectBackup(root);
  if (files.length + 1 > BK_MAX_FILES) throw new Error('Too many files for one zip (65,535). Use git sync, or back up a smaller folder.');
  let offset = 0; const central = [], skipped = [];
  const emit = async (buf) => {
    if (out.destroyed) throw new Error('the connection closed');
    offset += buf.length;
    if (!out.write(buf)) await Promise.race([once(out, 'drain'), once(out, 'close').then(() => { throw new Error('the connection closed'); })]);
  };
  const addEntry = async (name, mtimeMs, body) => {                                // body: a readable file handle stream (deflated) or a Buffer (stored)
    const nameBuf = Buffer.from(name, 'utf8'), { time, date } = dosTime(mtimeMs), start = offset, stored = Buffer.isBuffer(body);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(stored ? 0x0800 : 0x0808, 6); lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt16LE(nameBuf.length, 26);
    let crc = 0, usize = 0, csize = 0;
    if (stored) { crc = crc32(body); usize = csize = body.length; lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); }
    await emit(lh); await emit(nameBuf);
    if (stored) await emit(body);
    else {
      const defl = zlib.createDeflateRaw({ level: 6 });
      body.on('data', (c) => { crc = crc32(c, crc); usize += c.length; }); body.on('error', (e) => defl.destroy(e)); body.pipe(defl);
      for await (const chunk of defl) { csize += chunk.length; await emit(chunk); }
      if (usize > BK_MAX_BYTES || csize > BK_MAX_BYTES) throw new Error(`${name} is too large for the zip format (4 GB)`);
      const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12); await emit(dd);
    }
    central.push({ nameBuf, time, date, crc, csize, usize, start, flags: stored ? 0x0800 : 0x0808, method: stored ? 0 : 8 });
  };
  let count = 0;
  for (const f of files) {
    let fh; try { fh = await fs.open(f.file, 'r'); } catch (e) { skipped.push(`${f.name}: ${e.code || e.message}`); continue; }   // vanished or unreadable: leave it out, keep going
    try { const st = await fh.stat(); await addEntry(f.name, st.mtimeMs, fh.createReadStream({ autoClose: false })); count++; } finally { await fh.close().catch(() => {}); }
  }
  const info = `Plainnote backup\nCreated: ${new Date().toISOString()}\nFiles: ${count}\n${skipped.length ? `Left out (could not be read):\n${skipped.join('\n')}\n` : ''}\nRestore with: Plainnote > command palette > "Restore notes from a backup", or\n  node server.js restore <this file> <notes folder>\nA restore only adds files; it never overwrites an existing one.\n`;
  await addEntry('PLAINNOTE-BACKUP.txt', Date.now(), Buffer.from(info));
  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(c.flags, 8); h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24); h.writeUInt16LE(c.nameBuf.length, 28); h.writeUInt32LE(c.start, 42);
    await emit(h); await emit(c.nameBuf);
  }
  if (offset > BK_MAX_BYTES) throw new Error('This backup is over 4 GB, which one zip cannot hold. Use git sync, or back up in parts.');
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10); eocd.writeUInt32LE(offset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
  await emit(eocd); out.end(); await finished(out);
  return { files: count, bytes: offset, skipped };
}
async function backupZip(root, outPath) {
  const tmp = `${outPath}.partial`, ws = fsSync.createWriteStream(tmp);
  try { const r = await writeBackup(ws, path.resolve(root)); await fs.rename(tmp, outPath); return { ...r, path: outPath }; }
  catch (e) { ws.destroy(); await fs.rm(tmp, { force: true }); throw e; }
}

// ---- restore ----
async function readZipDirectory(fh, size) {
  const tailLen = Math.min(size, 65557), tail = Buffer.alloc(tailLen); await fh.read(tail, 0, tailLen, size - tailLen);
  let e = -1; for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('That is not a Plainnote backup (it is not a zip file)');
  const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('This zip uses zip64, which Plainnote backups never do');
  if (cdOff + cdSize > size || cdSize > 64e6) throw new Error('The backup file is damaged');
  const cd = Buffer.alloc(cdSize); await fh.read(cd, 0, cdSize, cdOff);
  const entries = []; let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('The backup file is damaged');
    const flags = cd.readUInt16LE(p + 8), nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    if (p + 46 + nl > cd.length) throw new Error('The backup file is damaged');
    entries.push({ flags, method: cd.readUInt16LE(p + 10), time: cd.readUInt16LE(p + 12), date: cd.readUInt16LE(p + 14), crc: cd.readUInt32LE(p + 16), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42), name: cd.toString('utf8', p + 46, p + 46 + nl) });
    p += 46 + nl + el + cl;
  }
  return entries;
}
async function fileCrc(file) { let c = 0; for await (const chunk of fsSync.createReadStream(file)) c = crc32(chunk, c); return c; }

// Returns { files, added, same, copies, skipped, notes, errors }. With dry: true nothing is written, it only reports what a restore would do.
async function restoreBackup(zipPath, root, { dry = false } = {}) {
  root = path.resolve(root); await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root), fh = await fs.open(zipPath, 'r');
  const sum = { files: 0, added: 0, same: 0, copies: 0, skipped: 0, notes: 0, errors: [] };
  try {
    const size = (await fh.stat()).size, entries = await readZipDirectory(fh, size); let declared = 0;
    for (const e of entries) {
      if (e.name === 'PLAINNOTE-BACKUP.txt') continue;                                // the backup's own description, not part of your notes
      sum.files++;
      const rel = e.name.replace(/\\/g, '/').replace(/^\/+/, ''), kind = (e.flags & 1) || (e.method !== 0 && e.method !== 8) ? null : backupKind(rel);
      const dest = kind && path.resolve(root, ...rel.split('/'));
      if (!kind || !dest.startsWith(root + path.sep)) { sum.skipped++; continue; }
      if ((declared += e.usize) > BK_MAX_TOTAL) throw new Error('This backup claims to hold far more data than a notes folder; refusing to restore it');
      const st = await fs.lstat(dest).catch(() => null);
      let target = dest, action = 'add';
      if (st) {
        if (!st.isFile()) { sum.skipped++; continue; }
        if (st.size === e.usize && await fileCrc(dest) === e.crc) { sum.same++; continue; }
        if (kind === 'history') { sum.skipped++; continue; }
        const ext = path.extname(dest), stem = dest.slice(0, dest.length - ext.length), bn = path.basename(stem);
        let have = false;                                                              // restoring twice must not pile up copies: an identical "(restored …)" file counts as already there
        for (const f of await fs.readdir(path.dirname(dest))) {
          if (!f.startsWith(bn + ' (restored ') || !f.endsWith(')' + ext)) continue;
          const full = path.join(path.dirname(dest), f), st2 = await fs.lstat(full).catch(() => null);
          if (st2 && st2.isFile() && st2.size === e.usize && await fileCrc(full) === e.crc) { have = true; break; }
        }
        if (have) { sum.same++; continue; }
        for (let n = 1; ; n++) { target = `${stem} (restored ${stamp()}${n > 1 ? ' ' + n : ''})${ext}`; if (!(await fs.lstat(target).catch(() => null))) break; }
        action = 'copy';
      }
      if (dry) { if (action === 'add') sum.added++; else sum.copies++; if (kind === 'note') sum.notes++; continue; }
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const realDir = await fs.realpath(path.dirname(target));
        if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) { sum.skipped++; continue; }       // a folder here is a link that leads outside
        await extractEntry(fh, e, target);
        if (action === 'add') sum.added++; else sum.copies++; if (kind === 'note') sum.notes++;
      } catch (err) { sum.errors.push(`${rel}: ${err.message}`); }
    }
  } finally { await fh.close().catch(() => {}); }
  return sum;
}
async function extractEntry(fh, e, target) {
  const lh = Buffer.alloc(30); await fh.read(lh, 0, 30, e.offset);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('damaged entry');
  const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), part = `${target}.partial-${process.pid}`;
  let bytes = 0, crc = 0;
  const guard = new Transform({ transform(c, _, cb) { bytes += c.length; if (bytes > e.usize) return cb(new Error('larger than the backup says')); crc = crc32(c, crc); cb(null, c); } });   // a lying size header cannot inflate a bomb
  const src = e.csize ? fh.createReadStream({ start, end: start + e.csize - 1, autoClose: false }) : Readable.from([]);
  try {
    await pipeline(src, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), guard, fsSync.createWriteStream(part, { flags: 'wx' }));
    if (bytes !== e.usize || crc !== e.crc) throw new Error('the file in the backup is damaged (checksum mismatch)');
    if (await fs.lstat(target).catch(() => null)) throw new Error('appeared while restoring; left alone');
    await fs.rename(part, target);
    const t = fromDos(e.time, e.date); await fs.utimes(target, t, t).catch(() => {});
  } catch (err) { await fs.rm(part, { force: true }); throw err; }
}

// opts.remote = { token }: remote mode for phones and other devices. Every request must then carry the secret token
// (cookie or Authorization header); without it the server behaves exactly as before: localhost only, no login.
function createServer(ROOT, hooks = {}, opts = {}) {
ROOT = path.resolve(ROOT);
const TRASH = path.join(ROOT, '.trash');
const SNIPPETS = path.join(ROOT, '.plainnote', 'snippets');
const HISTORY = path.join(ROOT, '.plainnote', 'history');
const HIST_EVERY = 2 * 60e3, HIST_KEEP = 60;       // snapshot at most every 2 minutes per note, keep the newest 60
const histDir = (name) => path.join(HISTORY, encodeURIComponent(name.replace(/\.md$/i, '')));
// Keep the previous text of a note before it is overwritten (plain files, independent of git).
async function snapshot(name, p) {
  try {
    const prev = await fs.readFile(p, 'utf8'); if (!prev.trim()) return;
    const dir = histDir(name), files = (await fs.readdir(dir).catch(() => [])).filter((f) => /^\d+\.md$/.test(f)).sort();
    const last = files.length ? Number(files[files.length - 1].slice(0, -3)) : 0;
    if (Date.now() - last < HIST_EVERY) return;
    if (files.length && await fs.readFile(path.join(dir, files[files.length - 1]), 'utf8').then((t) => t === prev, () => false)) return;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, Date.now() + '.md'), prev, 'utf8');
    for (const f of files.slice(0, Math.max(0, files.length + 1 - HIST_KEEP))) await fs.rm(path.join(dir, f), { force: true });
  } catch {}
}
const SNIPPET = /^\w[\w .-]*\.css$/;       // plain file names only: no slashes, so nothing outside the snippets folder is reachable

// Resolve a note name ("folder/idea") to a safe absolute .md path inside ROOT.
function notePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('bad name');
  const p = path.resolve(ROOT, name.replace(/\.md$/i, '') + '.md');
  if (!p.startsWith(ROOT + path.sep)) throw new Error('bad path');
  return p;
}

// Resolve a folder name ("a/b") to a safe absolute directory inside ROOT (no dot-folders, so .trash and .git stay out of reach).
function folderPath(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw new Error('bad name');
  const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((x) => x === '.' || x === '..' || x.startsWith('.'))) throw new Error('bad name');
  const p = path.resolve(ROOT, ...parts);
  if (!p.startsWith(ROOT + path.sep)) throw new Error('bad path');
  return p;
}
async function listFolders(dir, base = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    out.push(rel, ...(await listFolders(path.join(dir, e.name), rel)));
  }
  return out;
}

// Names and modification times only (no file contents): what the app needs to find out what changed since it last looked.
async function walkMeta(dir, base = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkMeta(path.join(dir, e.name), rel)));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push({ name: rel.replace(/\.md$/i, ''), mtime: (await fs.stat(path.join(dir, e.name))).mtimeMs });
  }
  return out;
}
async function walk(dir, base = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      const full = path.join(dir, e.name);
      const [text, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      out.push({ name: rel.replace(/\.md$/i, ''), text, mtime: st.mtimeMs });
    }
  }
  return out;
}

const body = (req) => new Promise((res, rej) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 10e6) { rej(new Error('too large')); req.destroy(); } });
  req.on('end', () => res(d));
  req.on('error', rej);
});

const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const ATTACH = { ...IMG, '.pdf': 'application/pdf' };      // uploadable and servable attachments
const rawBody = (req, max = 20e6) => new Promise((res, rej) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { rej(new Error('file too large (20MB max)')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => res(Buffer.concat(chunks)));
  req.on('error', rej);
});

const send = (res, code, data, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};
// Like send(), but gzips anything worth it when the client accepts it, and (with `etag`) answers 304 to a matching If-None-Match.
const sendEncoded = (req, res, code, data, type, headers = {}, etag = false) => new Promise((resolve) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data), h = { 'Content-Type': type, 'Vary': 'Accept-Encoding', ...headers };
  if (etag) {
    const tag = '"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"'; h.ETag = tag;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, h); res.end(); return resolve(); }
  }
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /^(text\/|application\/(json|javascript)|image\/svg)/.test(type)) {
    zlib.gzip(buf, (err, z) => { if (err) { res.writeHead(code, h); res.end(buf); } else { res.writeHead(code, { ...h, 'Content-Encoding': 'gzip' }); res.end(z); } resolve(); });
  } else { res.writeHead(code, h); res.end(buf); resolve(); }
});

// ---- Git sync (notes folder is plain files, so git is the sync backend) ----
const git = (args) => new Promise((resolve) => execFile('git', args, {
  cwd: ROOT, timeout: 60000, maxBuffer: 1e7, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || '').trim() })));

async function gitStatus() {
  const top = await git(['rev-parse', '--show-toplevel']);
  let isRepo = false;
  if (top.ok) { try { isRepo = (await fs.realpath(top.out)) === (await fs.realpath(ROOT)); } catch {} }
  if (!isRepo) return { isRepo: false, remote: '', dirty: 0 };
  const [remote, st] = await Promise.all([git(['remote', 'get-url', 'origin']), git(['status', '--porcelain'])]);
  return { isRepo, remote: remote.ok ? remote.out : '', dirty: st.out ? st.out.split('\n').length : 0 };
}

// Only allow real network remotes; "ext::" and local-command transports can run programs.
const REMOTE_OK = /^(https:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[\w.\-]+:[^\s]+)$/;

async function gitSetup(url) {
  if (!REMOTE_OK.test(url || '') || url.startsWith('-')) throw new Error('Remote must be an https://, ssh:// or git@host:path URL');
  const st = await gitStatus();
  if (!st.isRepo) {
    const r = await git(['init', '-b', 'main']);
    if (!r.ok) throw new Error(r.err);
    await fs.writeFile(path.join(ROOT, '.gitignore'), '.DS_Store\n.trash/\n', { flag: 'wx' }).catch(() => {});
  }
  const r = st.remote ? await git(['remote', 'set-url', 'origin', url]) : await git(['remote', 'add', 'origin', url]);
  if (!r.ok) throw new Error(r.err);
}

async function gitSync() {
  const st = await gitStatus();
  if (!st.isRepo || !st.remote) throw new Error('Sync is not set up');
  const ident = (await git(['config', 'user.email'])).out ? [] : ['-c', 'user.name=Notes', '-c', 'user.email=notes@localhost'];
  let r = await git(['add', '-A']);
  if (!r.ok) throw new Error(r.err);
  if ((await git(['status', '--porcelain'])).out) {
    r = await git([...ident, 'commit', '-m', `Sync ${new Date().toISOString()}`]);
    if (!r.ok) throw new Error(r.err);
  }
  const branch = (await git(['symbolic-ref', '--short', 'HEAD'])).out || 'main';
  r = await git([...ident, 'pull', '--rebase', '--autostash', 'origin', branch]);
  if (!r.ok && !/couldn't find remote ref/i.test(r.err)) {      // empty remote is fine on first push
    await git(['rebase', '--abort']);
    throw new Error('Pull failed (possible conflict, nothing was lost locally): ' + r.err.split('\n')[0]);
  }
  r = await git(['push', '-u', 'origin', branch]);
  if (!r.ok) throw new Error('Push failed: ' + r.err.split('\n').slice(-2).join(' '));
  return 'Synced ' + new Date().toLocaleTimeString();
}

const TYPES = { '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

// ---- remote mode: token auth ----
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
const sameToken = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));          // constant time, and the length does not leak
const failures = new Map();                                                    // ip -> recent failed attempts (a token was presented but wrong)
function authorize(req, res, url) {
  const token = opts.remote.token;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (bearer && sameToken(bearer[1], token)) return true;
  const ck = /(?:^|;\s*)pn_token=([^;]+)/.exec(req.headers.cookie || '');
  let cookie = ''; try { cookie = ck ? decodeURIComponent(ck[1]) : ''; } catch {}
  if (cookie && sameToken(cookie, token)) return true;
  const ip = req.socket.remoteAddress || '', now = Date.now(), recent = (failures.get(ip) || []).filter((t) => now - t < 60000);
  const q = url.searchParams.get('token');
  if (recent.length >= 10) { send(res, 429, { error: 'too many attempts, wait a minute' }); return false; }
  if (req.method === 'GET' && q && sameToken(q, token)) {                    // first visit from the link: remember it in a cookie and drop it from the URL
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.writeHead(302, { 'Set-Cookie': `pn_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? '; Secure' : ''}`, Location: '/', 'Cache-Control': 'no-store' });
    res.end(); return false;
  }
  if (q || bearer || cookie) { recent.push(now); failures.set(ip, recent); }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) send(res, 401, { error: 'unauthorized' });
  else send(res, 401, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plainnote</title><body style="font:16px system-ui;max-width:30em;margin:15vh auto;padding:0 1em"><h2>Plainnote</h2><p>This notes server needs its access link. Open the full link printed in the terminal where it was started (it ends in <code>?token=…</code>).</p>', 'text/html; charset=utf-8');
  return false;
}

return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Only answer to localhost (blocks DNS-rebinding), and block cross-site requests: only same-origin (or non-browser) callers.
    if (!opts.remote && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' });
    if (opts.remote && !authorize(req, res, url)) return;

    if (url.pathname === '/api/ping') { hooks.onPing?.(); return send(res, 200, { app: 'plainnote' }); }
    if (url.pathname === '/api/notes' && req.method === 'GET') {
      if (url.searchParams.get('meta') === '1') return sendEncoded(req, res, 200, JSON.stringify(await walkMeta(ROOT)), 'application/json', { 'Cache-Control': 'no-store' });
      return sendEncoded(req, res, 200, JSON.stringify(await walk(ROOT)), 'application/json', { 'Cache-Control': 'no-store' });          // the full list, compressed
    }
    if (url.pathname === '/api/notes/read' && req.method === 'POST') {          // the bodies of just the named notes (the app asks for what changed)
      const { names } = JSON.parse(await body(req));
      if (!Array.isArray(names) || names.length > 500) return send(res, 400, { error: 'send up to 500 names' });
      const out = [];
      for (const name of names) {
        let p; try { p = notePath(name); } catch { continue; }                  // a bad or traversing name is skipped, never read
        try { const [text, st] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)]); out.push({ name: String(name).replace(/\.md$/i, ''), text, mtime: st.mtimeMs }); } catch {}
      }
      return sendEncoded(req, res, 200, JSON.stringify(out), 'application/json', { 'Cache-Control': 'no-store' });
    }
    if (url.pathname === '/api/snippets' && req.method === 'GET') {        // user CSS: <notes>/.plainnote/snippets/*.css
      const files = await fs.readdir(SNIPPETS).catch(() => []);
      return send(res, 200, files.filter((f) => SNIPPET.test(f)).sort().map((name) => ({ name })));
    }
    if (url.pathname === '/api/snippet' && req.method === 'GET') {
      const name = url.searchParams.get('name') || '';
      if (!SNIPPET.test(name)) return send(res, 400, { error: 'bad name' });
      return send(res, 200, await fs.readFile(path.join(SNIPPETS, name), 'utf8'), 'text/css; charset=utf-8');
    }
    if (url.pathname === '/api/folders' && req.method === 'GET') return send(res, 200, (await listFolders(ROOT)).sort());
    if (url.pathname === '/api/folder') {
      if (req.method === 'POST') {                          // create (possibly nested) folder
        const { name } = JSON.parse(await body(req));
        await fs.mkdir(folderPath(name), { recursive: true });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {                        // only empty folders: notes are never removed this way
        try { await fs.rmdir(folderPath(url.searchParams.get('name'))); } catch (e) {
          if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') return send(res, 409, { error: 'not empty' });
          throw e;
        }
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/api/note') {
      const p = notePath(url.searchParams.get('name'));
      if (req.method === 'PUT') {
        // Optimistic concurrency: refuse to overwrite a file that changed since the client last saw it.
        const base = req.headers['x-base-mtime'] === undefined ? NaN : Number(req.headers['x-base-mtime']);
        if (Number.isFinite(base)) {
          const st = await fs.stat(p).catch(() => null);
          if (st && st.mtimeMs > base + 1) return send(res, 409, { error: 'conflict' });
        }
        await fs.mkdir(path.dirname(p), { recursive: true });
        const text = await body(req);
        await snapshot(url.searchParams.get('name'), p);
        await fs.writeFile(p, text, 'utf8');
        return send(res, 200, { ok: true, mtime: (await fs.stat(p)).mtimeMs });
      }
      if (req.method === 'DELETE') {                     // move to .trash instead of destroying
        const name = url.searchParams.get('name').replace(/\.md$/i, '');
        await fs.mkdir(TRASH, { recursive: true });
        const trashId = `${Date.now()}__${encodeURIComponent(name)}.md`;
        await fs.rename(p, path.join(TRASH, trashId));
        return send(res, 200, { ok: true, id: trashId });                 // the id lets the app offer Undo (POST /api/restore)
      }
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {          // versions of one note, newest first; ?id=<timestamp> returns that version's text
      const name = url.searchParams.get('name'); notePath(name);
      const dir = histDir(name), id = url.searchParams.get('id');
      if (id !== null) {
        if (!/^\d+$/.test(id)) return send(res, 400, { error: 'bad id' });
        return send(res, 200, { id: Number(id), text: await fs.readFile(path.join(dir, id + '.md'), 'utf8') });
      }
      const files = (await fs.readdir(dir).catch(() => [])).filter((f) => /^\d+\.md$/.test(f)).sort().reverse();
      return send(res, 200, await Promise.all(files.map(async (f) => ({ id: Number(f.slice(0, -3)), size: (await fs.stat(path.join(dir, f))).size }))));
    }
    if (url.pathname === '/api/append' && req.method === 'POST') {      // quick capture / URL scheme: append a block to a note (created if missing)
      const { name, text } = JSON.parse(await body(req));
      if (typeof text !== 'string') return send(res, 400, { error: 'text required' });
      const p = notePath(name);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const prev = await fs.readFile(p, 'utf8').catch(() => '');
      if (/^\s*-----BEGIN PLAINNOTE ENCRYPTED NOTE-----/.test(prev)) return send(res, 409, { error: 'this note is encrypted' });     // appending plain text would corrupt it
      await fs.writeFile(p, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + text.replace(/\n*$/, '\n'), 'utf8');
      return send(res, 200, { ok: true, mtime: (await fs.stat(p)).mtimeMs });
    }
    if (url.pathname === '/api/trash' && req.method === 'GET') {
      const files = await fs.readdir(TRASH).catch(() => []);
      return send(res, 200, files.filter((f) => /^\d+__.+\.md$/.test(f)).sort().reverse().map((f) => ({
        id: f, deleted: Number(f.split('__')[0]), name: decodeURIComponent(f.slice(f.indexOf('__') + 2, -3)) })));
    }
    if (url.pathname === '/api/trash' && req.method === 'DELETE') {
      await fs.rm(TRASH, { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/restore' && req.method === 'POST') {
      const { id } = JSON.parse(await body(req));
      if (!/^\d+__[^/\\]+\.md$/.test(id || '')) return send(res, 400, { error: 'bad id' });
      let name = decodeURIComponent(id.slice(id.indexOf('__') + 2, -3));
      while (await fs.access(notePath(name)).then(() => true, () => false)) name += ' (restored)';
      await fs.mkdir(path.dirname(notePath(name)), { recursive: true });
      await fs.rename(path.join(TRASH, id), notePath(name));
      return send(res, 200, { ok: true, name });
    }
    if (url.pathname === '/api/rename' && req.method === 'POST') {
      const { from, to } = JSON.parse(await body(req));
      const a = notePath(from), b = notePath(to);
      try { await fs.access(b); return send(res, 409, { error: 'exists' }); } catch {}
      await fs.mkdir(path.dirname(b), { recursive: true });
      await fs.rename(a, b);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const base = path.basename(url.searchParams.get('name') || 'image.png');
      const ext = path.extname(base).toLowerCase();
      if (!ATTACH[ext]) return send(res, 400, { error: 'unsupported attachment type' });
      const safe = base.slice(0, -ext.length).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'image';
      const rel = `attachments/${Date.now()}-${safe}${ext}`;
      await fs.mkdir(path.join(ROOT, 'attachments'), { recursive: true });
      await fs.writeFile(path.join(ROOT, rel), await rawBody(req));
      return send(res, 200, { path: rel });
    }
    if (url.pathname.startsWith('/files/') && req.method === 'GET') {
      const f = path.resolve(ROOT, decodeURIComponent(url.pathname.slice(7)));
      const type = ATTACH[path.extname(f).toLowerCase()];
      if (!f.startsWith(ROOT + path.sep) || !type) return send(res, 404, { error: 'not found' });
      // SVG can't run scripts; PDFs are shown by the browser's viewer, which a CSP sandbox would block
      if (type !== 'application/pdf') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      else res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return send(res, 200, await fs.readFile(f), type);
    }
    if (url.pathname === '/api/backup' && req.method === 'GET') {            // download a zip of all notes, streamed
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'forbidden' });     // another website must not be able to start a download
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="plainnote-backup-${stamp()}.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      try { await writeBackup(res, ROOT); } catch (e) { res.destroy(e); }
      return;
    }
    if (url.pathname === '/api/backup/save' && req.method === 'POST') {      // for the desktop app, where a download link is not available: write to the Downloads folder (a fixed place, never a path from the client)
      const dir = process.env.PLAINNOTE_BACKUP_DIR || (fsSync.existsSync(path.join(os.homedir(), 'Downloads')) ? path.join(os.homedir(), 'Downloads') : os.homedir());
      let file = path.join(dir, `plainnote-backup-${stamp()}.zip`);
      for (let n = 2; fsSync.existsSync(file); n++) file = path.join(dir, `plainnote-backup-${stamp()} ${n}.zip`);
      const r = await backupZip(ROOT, file);
      return send(res, 200, { path: r.path, files: r.files, bytes: r.bytes });
    }
    if (url.pathname === '/api/backup/restore' && req.method === 'POST') {   // ?mode=dry reports what would happen; ?mode=apply adds the missing files (never overwrites)
      const dry = url.searchParams.get('mode') !== 'apply', tmp = path.join(os.tmpdir(), `plainnote-restore-${crypto.randomBytes(6).toString('hex')}.zip`);
      let n = 0;
      try {
        await pipeline(req, new Transform({ transform(c, _, cb) { n += c.length; n > 4 * 1024 ** 3 ? cb(new Error('That file is too large for a Plainnote backup')) : cb(null, c); } }), fsSync.createWriteStream(tmp));
        return send(res, 200, await restoreBackup(tmp, ROOT, { dry }));
      } finally { await fs.rm(tmp, { force: true }); }
    }
    if (url.pathname === '/api/sync/status' && req.method === 'GET') return send(res, 200, await gitStatus());
    if (url.pathname === '/api/sync/setup' && req.method === 'POST') {
      try { await gitSetup(JSON.parse(await body(req)).url); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      try { return send(res, 200, { ok: true, message: await gitSync() }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      return sendEncoded(req, res, 200, await readPublic(rel), TYPES[path.extname(rel)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' }, true);   // revalidated with an ETag: unchanged files cost a 304
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : e.code === 'EACCES' ? 403 : 400, { error: e.message });
  }
});
}

// The secret for remote mode lives in <notes>/.plainnote/token (created on first use, readable by you only).
async function ensureToken(root) {
  const dir = path.join(root, '.plainnote'), file = path.join(dir, 'token');
  try { const t = (await fs.readFile(file, 'utf8')).trim(); if (t.length >= 32) return t; } catch {}
  const t = crypto.randomBytes(32).toString('base64url');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, t + '\n', { mode: 0o600 });
  return t;
}

// Start a server (127.0.0.1 unless opts.host says otherwise). port 0 picks a free port. Resolves { server, port, root, token? }.
async function listen(root, port, hooks, opts = {}) {
  root = path.resolve(root);
  await fs.mkdir(root, { recursive: true });
  const token = opts.remote ? await ensureToken(root) : null;
  const server = createServer(root, hooks, token ? { remote: { token } } : {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, opts.host || '127.0.0.1', resolve); });
  return { server, port: server.address().port, root, token };
}

module.exports = { createServer, listen, backupZip, restoreBackup };

if (require.main === module && process.argv[2] === 'export') {
  // node server.js export <note.md> [out.pdf]  — render a note to PDF with an installed Chrome/Edge/Chromium (no npm deps)
  require('./scripts/export-pdf').run(process.argv.slice(3)).then((o) => console.log(o), (e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module && process.argv[2] === 'publish') {
  require('./scripts/publish').run(process.argv.slice(3)).then((o) => console.log(o), (e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module && process.argv[2] === 'backup') {
  // node server.js backup <notesDir> [out.zip | folder/] [--keep N]
  (async () => {
    const a = process.argv.slice(3), pos = []; let keep = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] === '--keep') keep = Math.max(0, parseInt(a[++i], 10) || 0); else pos.push(a[i]); }
    if (!pos[0]) throw new Error('usage: node server.js backup <notesDir> [out.zip | folder/] [--keep N]');
    const root = path.resolve(pos[0]); if (!fsSync.existsSync(root)) throw new Error(`${root} does not exist`);
    let out = pos[1] ? path.resolve(pos[1]) : process.cwd(), dirMode = !pos[1] || /[\\/]$/.test(pos[1]) || (fsSync.existsSync(out) && fsSync.statSync(out).isDirectory());
    if (dirMode) { await fs.mkdir(out, { recursive: true }); const d = new Date(); out = path.join(out, `plainnote-backup-${stamp(d)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}.zip`); }
    if (out.startsWith(root + path.sep)) throw new Error('Write the backup outside the notes folder');
    const r = await backupZip(root, out);
    if (dirMode && keep) { const dir = path.dirname(out), old = (await fs.readdir(dir)).filter((f) => /^plainnote-backup-.*\.zip$/.test(f)).sort().reverse().slice(keep); for (const f of old) await fs.rm(path.join(dir, f), { force: true }); if (old.length) r.pruned = old.length; }
    return `Backed up ${r.files} file${r.files === 1 ? '' : 's'} (${(r.bytes / 1048576).toFixed(1)} MB) to ${r.path}` + (r.pruned ? `\nRemoved ${r.pruned} older backup${r.pruned === 1 ? '' : 's'}` : '') + (r.skipped.length ? '\n' + r.skipped.map((x) => '  ! ' + x).join('\n') : '');
  })().then((o) => console.log(o), (e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module && process.argv[2] === 'restore') {
  // node server.js restore <backup.zip> <notesDir> [--dry-run]
  (async () => {
    const a = process.argv.slice(3).filter((x) => x !== '--dry-run'), dry = process.argv.includes('--dry-run');
    if (a.length < 2) throw new Error('usage: node server.js restore <backup.zip> <notesDir> [--dry-run]');
    if (!fsSync.existsSync(a[0])) throw new Error(`${a[0]} does not exist`);
    const r = await restoreBackup(path.resolve(a[0]), path.resolve(a[1]), { dry });
    return `${dry ? 'Would restore' : 'Restored'}: ${r.added} new file${r.added === 1 ? '' : 's'}, ${r.same} already identical, ${r.copies} kept as separate "(restored …)" cop${r.copies === 1 ? 'y' : 'ies'}, ${r.skipped} skipped` + (r.errors.length ? '\n' + r.errors.map((x) => '  ! ' + x).join('\n') : '');
  })().then((o) => console.log(o), (e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module && process.argv[2] === 'import') {
  require('./scripts/import').run(process.argv.slice(3)).then((o) => console.log(o), (e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module && process.argv[2] === 'pdf') {
  require('./scripts/pdf-tools').run(process.argv.slice(3)).then((o) => console.log(o), (e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module) {
  // node server.js [notesDir] [port] [--remote] [--host 0.0.0.0]
  const args = process.argv.slice(2), pos = [], opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--remote') opts.remote = true;
    else if (args[i] === '--host') opts.host = args[++i];
    else if (!args[i].startsWith('--')) pos.push(args[i]);
  }
  const root = pos[0] || path.join(__dirname, 'notes');
  const port = Number(pos[1] || process.env.PORT || 4777);
  listen(root, port, undefined, opts).then((r) => {
    // Desktop wrapper: exit when the parent app dies and closes our stdin.
    if (process.env.NOTES_WATCH_STDIN) { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
    if (r.token) {
      const host = opts.host && opts.host !== '0.0.0.0' ? opts.host : 'localhost';
      console.log(`Notes: ${r.root}\nRemote mode: every request needs the token. Do not share this link; serve it over HTTPS (e.g. tailscale serve) when it leaves your machine.\nOpen:  http://${host}:${r.port}/?token=${r.token}`);
    } else console.log(`Notes: ${r.root}\nOpen:  http://localhost:${r.port}`);
  }, (e) => { console.error(e.message); process.exit(1); });
}
