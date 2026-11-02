#!/usr/bin/env node
// Zero-dependency local notes server. Usage: node server.js [notesDir] [port]
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

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

function createServer(ROOT, hooks = {}) {
ROOT = path.resolve(ROOT);
const TRASH = path.join(ROOT, '.trash');
const SNIPPETS = path.join(ROOT, '.plainnote', 'snippets');
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Only answer to localhost (blocks DNS-rebinding), and block cross-site requests: only same-origin (or non-browser) callers.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' });

    if (url.pathname === '/api/ping') { hooks.onPing?.(); return send(res, 200, { app: 'plainnote' }); }
    if (url.pathname === '/api/notes' && req.method === 'GET') return send(res, 200, await walk(ROOT));
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
        await fs.writeFile(p, await body(req), 'utf8');
        return send(res, 200, { ok: true, mtime: (await fs.stat(p)).mtimeMs });
      }
      if (req.method === 'DELETE') {                     // move to .trash instead of destroying
        const name = url.searchParams.get('name').replace(/\.md$/i, '');
        await fs.mkdir(TRASH, { recursive: true });
        await fs.rename(p, path.join(TRASH, `${Date.now()}__${encodeURIComponent(name)}.md`));
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/api/append' && req.method === 'POST') {      // quick capture / URL scheme: append a block to a note (created if missing)
      const { name, text } = JSON.parse(await body(req));
      if (typeof text !== 'string') return send(res, 400, { error: 'text required' });
      const p = notePath(name);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const prev = await fs.readFile(p, 'utf8').catch(() => '');
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
      if (!IMG[ext]) return send(res, 400, { error: 'unsupported image type' });
      const safe = base.slice(0, -ext.length).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'image';
      const rel = `attachments/${Date.now()}-${safe}${ext}`;
      await fs.mkdir(path.join(ROOT, 'attachments'), { recursive: true });
      await fs.writeFile(path.join(ROOT, rel), await rawBody(req));
      return send(res, 200, { path: rel });
    }
    if (url.pathname.startsWith('/files/') && req.method === 'GET') {
      const f = path.resolve(ROOT, decodeURIComponent(url.pathname.slice(7)));
      const type = IMG[path.extname(f).toLowerCase()];
      if (!f.startsWith(ROOT + path.sep) || !type) return send(res, 404, { error: 'not found' });
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");   // SVG can't run scripts
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return send(res, 200, await fs.readFile(f), type);
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
      return send(res, 200, await readPublic(rel), TYPES[path.extname(rel)] || 'application/octet-stream');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : e.code === 'EACCES' ? 403 : 400, { error: e.message });
  }
});
}

// Start a server on 127.0.0.1. port 0 picks a free port. Resolves { server, port, root }.
async function listen(root, port, hooks) {
  root = path.resolve(root);
  await fs.mkdir(root, { recursive: true });
  const server = createServer(root, hooks);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, port: server.address().port, root };
}

module.exports = { createServer, listen };

if (require.main === module) {
  const root = process.argv[2] || path.join(__dirname, 'notes');
  const port = Number(process.argv[3] || process.env.PORT || 4777);
  listen(root, port).then((r) => {
    // Desktop wrapper: exit when the parent app dies and closes our stdin.
    if (process.env.NOTES_WATCH_STDIN) { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
    console.log(`Notes: ${r.root}\nOpen:  http://localhost:${r.port}`);
  }, (e) => { console.error(e.message); process.exit(1); });
}
