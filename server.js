#!/usr/bin/env node
// Zero-dependency local notes server. Usage: node server.js [notesDir] [port]
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, 'notes'));
const PORT = Number(process.argv[3] || process.env.PORT || 4777);
const PUBLIC = path.join(__dirname, 'public');

// Resolve a note name ("folder/idea") to a safe absolute .md path inside ROOT.
function notePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('bad name');
  const p = path.resolve(ROOT, name.replace(/\.md$/i, '') + '.md');
  if (!p.startsWith(ROOT + path.sep)) throw new Error('bad path');
  return p;
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
    await fs.writeFile(path.join(ROOT, '.gitignore'), '.DS_Store\n', { flag: 'wx' }).catch(() => {});
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

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Only answer to localhost (blocks DNS-rebinding), and block cross-site requests: only same-origin (or non-browser) callers.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' });

    if (url.pathname === '/api/notes' && req.method === 'GET') return send(res, 200, await walk(ROOT));
    if (url.pathname === '/api/note') {
      const p = notePath(url.searchParams.get('name'));
      if (req.method === 'PUT') {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, await body(req), 'utf8');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') { await fs.unlink(p); return send(res, 200, { ok: true }); }
    }
    if (url.pathname === '/api/rename' && req.method === 'POST') {
      const { from, to } = JSON.parse(await body(req));
      const a = notePath(from), b = notePath(to);
      try { await fs.access(b); return send(res, 409, { error: 'exists' }); } catch {}
      await fs.mkdir(path.dirname(b), { recursive: true });
      await fs.rename(a, b);
      return send(res, 200, { ok: true });
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
      const f = path.resolve(PUBLIC, rel);
      if (!f.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, await fs.readFile(f), TYPES[path.extname(f)] || 'application/octet-stream');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  console.log(`Notes: ${ROOT}\nOpen:  http://localhost:${PORT}`);
});
