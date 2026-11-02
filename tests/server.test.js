const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-'));
  const port = await free();
  const proc = spawn(process.execPath, [SERVER, dir, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Open:/.test(d) && res()); proc.on('exit', rej); });
  const base = `http://127.0.0.1:${port}`;
  const j = async (u, o) => { const r = await fetch(base + u, o); return { status: r.status, body: await r.json().catch(() => null), res: r }; };
  const put = (name, text, headers = {}) => j('/api/note?name=' + encodeURIComponent(name), { method: 'PUT', body: text, headers });
  return { dir, base, j, put, stop: () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('notes CRUD, subfolders, and listing', async () => {
  const s = await start();
  try {
    assert.equal((await s.put('one', 'hello')).status, 200);
    assert.equal((await s.put('a/b/deep', 'x')).status, 200);
    const list = (await s.j('/api/notes')).body;
    assert.deepEqual(list.map((n) => n.name).sort(), ['a/b/deep', 'one']);
    assert.equal(list.find((n) => n.name === 'one').text, 'hello');
    assert.ok(fs.existsSync(path.join(s.dir, 'a/b/deep.md')));
  } finally { s.stop(); }
});

test('rejects path traversal, bad hosts and cross-site origins', async () => {
  const s = await start();
  try {
    assert.equal((await s.put('../../evil', 'x')).status, 400);
    assert.equal((await s.j('/files/../server.js')).status, 404);
    assert.equal((await s.j('/api/notes', { headers: { origin: 'http://evil.example' } })).status, 403);
    // fetch can't forge Host, so use a raw socket
    const code = await new Promise((res) => {
      const sock = net.connect(Number(new URL(s.base).port), '127.0.0.1', () => sock.write('GET /api/notes HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'));
      sock.on('data', (d) => { res(String(d).split(' ')[1]); sock.destroy(); });
    });
    assert.equal(code, '403');
  } finally { s.stop(); }
});

test('optimistic concurrency returns 409 when the file changed underneath', async () => {
  const s = await start();
  try {
    const first = await s.put('n', 'v1');
    assert.equal((await s.put('n', 'v2', { 'x-base-mtime': String(first.body.mtime) })).status, 200);
    assert.equal((await s.put('n', 'stale', { 'x-base-mtime': String(first.body.mtime - 5000) })).status, 409);
    assert.equal(fs.readFileSync(path.join(s.dir, 'n.md'), 'utf8'), 'v2');
    assert.equal((await s.put('n', 'x', { 'x-base-mtime': '0' })).status, 409);          // creating over an existing note
    assert.equal((await s.put('fresh', 'x', { 'x-base-mtime': '0' })).status, 200);
  } finally { s.stop(); }
});

test('rename moves notes and refuses to overwrite', async () => {
  const s = await start();
  try {
    await s.put('a', '1'); await s.put('b', '2');
    const post = (from, to) => s.j('/api/rename', { method: 'POST', body: JSON.stringify({ from, to }) });
    assert.equal((await post('a', 'b')).status, 409);
    assert.equal((await post('a', 'c/a2')).status, 200);
    assert.ok(fs.existsSync(path.join(s.dir, 'c/a2.md')) && !fs.existsSync(path.join(s.dir, 'a.md')));
  } finally { s.stop(); }
});

test('delete moves to trash; restore, name clash and empty', async () => {
  const s = await start();
  try {
    await s.put('keep/me', 'precious');
    assert.equal((await s.j('/api/note?name=keep%2Fme', { method: 'DELETE' })).status, 200);
    assert.deepEqual((await s.j('/api/notes')).body, []);
    const t = (await s.j('/api/trash')).body;
    assert.equal(t.length, 1); assert.equal(t[0].name, 'keep/me');
    await s.put('keep/me', 'new one');
    const r = await s.j('/api/restore', { method: 'POST', body: JSON.stringify({ id: t[0].id }) });
    assert.equal(r.body.name, 'keep/me (restored)');
    assert.equal(fs.readFileSync(path.join(s.dir, 'keep/me (restored).md'), 'utf8'), 'precious');
    assert.equal((await s.j('/api/restore', { method: 'POST', body: JSON.stringify({ id: '../x.md' }) })).status, 400);
    await s.j('/api/note?name=keep%2Fme', { method: 'DELETE' });
    await s.j('/api/trash', { method: 'DELETE' });
    assert.deepEqual((await s.j('/api/trash')).body, []);
  } finally { s.stop(); }
});

test('image upload and safe serving', async () => {
  const s = await start();
  try {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const up = await s.j('/api/upload?name=' + encodeURIComponent('my pic.png'), { method: 'POST', body: png });
    assert.equal(up.status, 200); assert.match(up.body.path, /^attachments\/\d+-my-pic\.png$/);
    const got = await fetch(`${s.base}/files/${up.body.path}`);
    assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
    assert.equal((await s.j('/api/upload?name=x.html', { method: 'POST', body: 'x' })).status, 400);
    await s.put('n', 'text');
    assert.equal((await s.j('/files/n.md')).status, 404);
    const svg = await s.j('/api/upload?name=a.svg', { method: 'POST', body: '<svg onload=alert(1)/>' });
    const sr = await fetch(`${s.base}/files/${svg.body.path}`);
    assert.match(sr.headers.get('content-security-policy'), /sandbox/);
  } finally { s.stop(); }
});

test('sync rejects dangerous remotes and syncs between two folders', async () => {
  try { execFileSync('git', ['--version']); } catch { return; }
  const a = await start(), b = await start();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-remote-')) + '/r.git';
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    for (const u of ['ext::sh -c touch /tmp/x', '-oProxyCommand=x', '/local/path', 'file:///x'])
      assert.equal((await a.j('/api/sync/setup', { method: 'POST', body: JSON.stringify({ url: u }) })).status, 400);
    for (const s of [a, b]) {
      assert.equal((await s.j('/api/sync/setup', { method: 'POST', body: JSON.stringify({ url: 'https://example.test/r.git' }) })).status, 200);
      execFileSync('git', ['-C', s.dir, 'config', `url.file://${remote}.insteadOf`, 'https://example.test/r.git']);
    }
    await a.put('from-a', 'A');
    assert.equal((await a.j('/api/sync', { method: 'POST' })).status, 200);
    assert.equal((await b.j('/api/sync', { method: 'POST' })).status, 200);
    assert.equal(fs.readFileSync(path.join(b.dir, 'from-a.md'), 'utf8'), 'A');
    await b.put('from-b', 'B');
    await b.j('/api/sync', { method: 'POST' }); await a.j('/api/sync', { method: 'POST' });
    assert.equal(fs.readFileSync(path.join(a.dir, 'from-b.md'), 'utf8'), 'B');
    const st = (await a.j('/api/sync/status')).body;
    assert.equal(st.isRepo, true); assert.equal(st.dirty, 0);
  } finally { a.stop(); b.stop(); fs.rmSync(path.dirname(remote), { recursive: true, force: true }); }
});

test('append creates or extends a note and stays inside the notes folder', async () => {
  const s = await start();
  try {
    const post = (b) => s.j('/api/append', { method: 'POST', body: JSON.stringify(b) });
    assert.equal((await post({ name: 'daily/2026-11-01', text: '- 09:00 first' })).status, 200);
    assert.equal((await post({ name: 'daily/2026-11-01', text: '- 09:05 second\n\n' })).status, 200);
    assert.equal(fs.readFileSync(path.join(s.dir, 'daily', '2026-11-01.md'), 'utf8'), '- 09:00 first\n- 09:05 second\n');
    fs.writeFileSync(path.join(s.dir, 'nonl.md'), 'no newline');
    await post({ name: 'nonl', text: 'next' });
    assert.equal(fs.readFileSync(path.join(s.dir, 'nonl.md'), 'utf8'), 'no newline\nnext\n');
    assert.equal((await post({ name: '../escape', text: 'x' })).status >= 400, true);
    assert.equal((await post({ name: 'x' })).status, 400);
    assert.equal(fs.existsSync(path.join(s.dir, '..', 'escape.md')), false);
  } finally { s.stop(); }
});

test('folders: create, list, delete only when empty, and stay inside the notes folder', async () => {
  const s = await start();
  try {
    const post = (name) => s.j('/api/folder', { method: 'POST', body: JSON.stringify({ name }) });
    assert.equal((await post('projects/2026')).status, 200);
    assert.equal((await post('empty')).status, 200);
    await s.put('projects/plan', 'x');
    assert.deepEqual((await s.j('/api/folders')).body, ['empty', 'projects', 'projects/2026']);
    assert.ok(fs.statSync(path.join(s.dir, 'projects/2026')).isDirectory());
    for (const bad of ['../outside', '/abs/../../x', '.hidden', 'a/../../b', '', 'a/.git']) {
      const r = await post(bad);
      assert.ok(r.status >= 400, `rejected ${JSON.stringify(bad)}`);
    }
    assert.equal(fs.existsSync(path.join(s.dir, '..', 'outside')), false);
    assert.equal((await s.j('/api/folder?name=projects', { method: 'DELETE' })).status, 409, 'non-empty folder is kept');
    assert.ok(fs.existsSync(path.join(s.dir, 'projects/plan.md')), 'its notes are untouched');
    assert.equal((await s.j('/api/folder?name=empty', { method: 'DELETE' })).status, 200);
    assert.equal(fs.existsSync(path.join(s.dir, 'empty')), false);
    assert.ok((await s.j('/api/folder?name=..', { method: 'DELETE' })).status >= 400);
  } finally { s.stop(); }
});

test('CSS snippets are listed and served from .plainnote/snippets only', async () => {
  const s = await start();
  try {
    assert.deepEqual((await s.j('/api/snippets')).body, [], 'none yet');
    fs.mkdirSync(path.join(s.dir, '.plainnote/snippets'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, '.plainnote/snippets/dark tweaks.css'), 'body{--x:1}');
    fs.writeFileSync(path.join(s.dir, '.plainnote/snippets/readme.txt'), 'not css');
    fs.writeFileSync(path.join(s.dir, 'secret.css'), 'outside');
    assert.deepEqual((await s.j('/api/snippets')).body, [{ name: 'dark tweaks.css' }]);
    const r = await fetch(s.base + '/api/snippet?name=' + encodeURIComponent('dark tweaks.css'));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/css/);
    assert.equal(await r.text(), 'body{--x:1}');
    for (const bad of ['../../secret.css', '../secret.css', 'sub/x.css', 'readme.txt', '', '.hidden.css', '..%2Fsecret.css']) {
      const x = await fetch(s.base + '/api/snippet?name=' + bad.replace(/\//g, '%2F'));
      assert.ok(x.status >= 400, `rejected ${JSON.stringify(bad)}`);
      assert.notEqual(await x.text(), 'outside');
    }
  } finally { s.stop(); }
});
