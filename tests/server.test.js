// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function start(extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-'));
  const port = await free();
  const proc = spawn(process.execPath, [SERVER, dir, String(port), ...extra], { stdio: ['pipe', 'pipe', 'inherit'] });
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

test('remote mode: every request needs the token; local mode is unchanged', async () => {
  const s = await start(['--remote']);
  try {
    const token = fs.readFileSync(path.join(s.dir, '.plainnote/token'), 'utf8').trim();
    assert.ok(token.length >= 32, 'a long random token');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(s.dir, '.plainnote/token')).mode & 0o077, 0, 'readable by the owner only');
    const get = (u, h = {}) => fetch(s.base + u, { headers: h, redirect: 'manual' });
    assert.equal((await get('/api/notes')).status, 401, 'no token');
    assert.equal((await get('/')).status, 401, 'not even the page');
    assert.match(await (await get('/')).text(), /access link/, 'with a pointer to the link');
    assert.equal((await get('/files/x.png')).status, 401);
    assert.equal((await get('/api/notes', { Authorization: 'Bearer nope' })).status, 401, 'wrong bearer token');
    assert.equal((await get('/api/notes', { Authorization: 'Bearer ' + token })).status, 200, 'bearer token');
    assert.equal((await get('/api/notes', { Cookie: 'pn_token=' + token })).status, 200, 'cookie');
    assert.equal((await get('/api/notes', { Cookie: 'pn_token=' + token.slice(0, -1) + 'x' })).status, 401, 'almost right is wrong');
    // the link sets a cookie and strips the token from the URL
    const login = await get('/?token=' + token);
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/, 'plain http cannot use Secure cookies');
    const secure = await get('/?token=' + token, { 'X-Forwarded-Proto': 'https' });
    assert.match(secure.headers.get('set-cookie'), /Secure/, 'behind an HTTPS proxy the cookie is Secure');
    const page = await get('/', { Cookie: cookie.split(';')[0] });
    assert.equal(page.status, 200); assert.match(await page.text(), /Plainnote/);
    // writes work with the cookie, and cross-site requests are still refused even with a valid token
    const auth = { Cookie: 'pn_token=' + token };
    assert.equal((await fetch(s.base + '/api/note?name=n', { method: 'PUT', body: 'x', headers: auth })).status, 200);
    assert.equal((await get('/api/notes', { ...auth, Origin: 'https://evil.example' })).status, 403);
    // a proxy or Tailscale name is fine in remote mode: the token, not the Host header, is the gate
    const status = await new Promise((r) => require('node:http').get(s.base + '/api/notes', { headers: { Host: 'mac.tailnet.ts.net', ...auth } }, (res) => { res.resume(); r(res.statusCode); }));
    assert.equal(status, 200);
    // guessing is throttled
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await get('/api/notes', { Authorization: 'Bearer guess' + i })).status;
    assert.equal(last, 429, 'too many wrong tokens');
    assert.equal((await get('/api/notes', { Authorization: 'Bearer ' + token })).status, 200, 'a valid token still works while guessing is throttled');
    // the token survives a restart
    assert.equal(fs.readFileSync(path.join(s.dir, '.plainnote/token'), 'utf8').trim(), token);
  } finally { s.stop(); }
  const local = await start();
  try {
    assert.equal((await local.j('/api/notes')).status, 200, 'local mode needs no token');
    assert.equal(fs.existsSync(path.join(local.dir, '.plainnote/token')), false, 'and creates none');
  } finally { local.stop(); }
});

test('installable web app: manifest, icons and service worker are served', async () => {
  const s = await start();
  try {
    const m = await fetch(s.base + '/manifest.webmanifest');
    assert.equal(m.status, 200);
    assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
    const man = await m.json();
    for (const k of ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color', 'background_color']) assert.ok(man[k], k);
    assert.equal(man.display, 'standalone');
    for (const ic of man.icons) {                                         // every declared icon exists and really has the declared size
      const r = await fetch(s.base + '/' + ic.src); assert.equal(r.status, 200, ic.src);
      assert.equal(r.headers.get('content-type'), 'image/png');
      const b = Buffer.from(await r.arrayBuffer()), [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
      assert.equal(`${w}x${h}`, ic.sizes, ic.src);
    }
    assert.ok(man.icons.some((i) => i.sizes === '192x192') && man.icons.some((i) => i.sizes === '512x512'), 'both sizes Chrome requires to install');
    const sw = await fetch(s.base + '/sw.js');
    assert.equal(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/);
    const code = await sw.text();
    assert.match(code, /startsWith\('\/api\/'\)/, 'the service worker never caches notes');
    const html = await (await fetch(s.base + '/')).text();
    assert.match(html, /rel="manifest"/); assert.match(html, /apple-touch-icon/); assert.match(html, /viewport-fit=cover/);
  } finally { s.stop(); }
});

test('pdf attachments upload and serve inline (no sandbox), other types still rejected', async () => {
  const s = await start();
  try {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    const up = await s.j('/api/upload?name=' + encodeURIComponent('My Report.pdf'), { method: 'POST', body: pdf });
    assert.equal(up.status, 200); assert.match(up.body.path, /^attachments\/\d+-My-Report\.pdf$/);
    const got = await fetch(`${s.base}/files/${up.body.path}`);
    assert.equal(got.headers.get('content-type'), 'application/pdf');
    assert.equal(got.headers.get('content-security-policy'), null);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await s.j('/api/upload?name=x.exe', { method: 'POST', body: 'x' })).status, 400);
  } finally { s.stop(); }
});

test('pdf tools validate page ranges', () => {
  const { pages } = require('../scripts/pdf-tools');
  assert.deepEqual(pages('1,3-4', 5), [0, 2, 3]);
  assert.throws(() => pages('6', 5), /outside/);
  assert.throws(() => pages('a', 5), /bad page range/);
});

test('export renders a note to HTML with local images resolved', () => {
  const { toHtml } = require('../scripts/export-pdf');
  const h = toHtml('/n/a.md', '# T\n\n![x](attachments/p.png)', '/n');
  assert.match(h, /<title>a<\/title>/); assert.match(h, /src="file:\/\/\/(?:[A-Za-z]:\/)?n\/attachments\/p\.png"/);
});

test('version history keeps earlier versions of a note, throttled, and serves them back', async () => {
  const s = await start();
  try {
    await s.put('h', 'one'); await s.put('h', 'two');                    // first overwrite snapshots "one"
    await s.put('h', 'three');                                           // within 2 minutes: no second snapshot
    const list = (await s.j('/api/history?name=h')).body;
    assert.equal(list.length, 1);
    const v = (await s.j('/api/history?name=h&id=' + list[0].id)).body; assert.equal(v.text, 'one');
    assert.equal((await s.j('/api/history?name=h&id=../x')).status, 400);
    assert.deepEqual((await s.j('/api/history?name=none')).body, []);
    assert.equal((await s.j('/api/history?name=' + encodeURIComponent('../x'))).status, 400);
    assert.ok(!(await s.j('/api/notes')).body.some((n) => n.name.includes('history')));   // snapshots never show up as notes
  } finally { s.stop(); }
});

test('publish builds a static site: links, attachments, privacy and safe output folders', () => {
  const fsx = require('fs'), os = require('os'), pth = require('path');
  const { build } = require('../scripts/publish');
  const src = fsx.mkdtempSync(pth.join(os.tmpdir(), 'pn-src-')), out = pth.join(fsx.mkdtempSync(pth.join(os.tmpdir(), 'pn-out-')), 'site');
  fsx.mkdirSync(pth.join(src, 'sub')); fsx.mkdirSync(pth.join(src, 'attachments'));
  fsx.writeFileSync(pth.join(src, 'Home.md'), '# Home\n\n[[Deep]] [[Secret]]\n\n![p](attachments/a.png)\n');
  fsx.writeFileSync(pth.join(src, 'sub', 'Deep.md'), 'back [[Home]]');
  fsx.writeFileSync(pth.join(src, 'Secret.md'), '---\npublish: false\n---\ntop secret');
  fsx.writeFileSync(pth.join(src, 'attachments', 'a.png'), 'png');
  const r = build(src, out, { title: 'T' });
  assert.equal(r.pages, 2); assert.deepEqual(r.skipped, ['Secret']); assert.equal(r.attachments, 1);
  const home = fsx.readFileSync(pth.join(out, 'Home.html'), 'utf8');
  assert.match(home, /href="sub\/Deep\.html"/); assert.match(home, /src="attachments\/a\.png"/);
  assert.doesNotMatch(home, /Secret\.html/);
  assert.match(fsx.readFileSync(pth.join(out, 'sub', 'Deep.html'), 'utf8'), /href="\.\.\/Home\.html"/);
  assert.ok(fsx.existsSync(pth.join(out, 'attachments', 'a.png')));
  for (const f of ['Home.html', 'index.html', 'sub/Deep.html']) assert.doesNotMatch(fsx.readFileSync(pth.join(out, f), 'utf8'), /top secret/);
  build(src, out);                                                           // rebuilding our own output is fine
  assert.throws(() => build(src, src), /must not contain or equal/);
  assert.throws(() => build(src, pth.join(src, 'sub')), /dot-folder/);
  const other = fsx.mkdtempSync(pth.join(os.tmpdir(), 'pn-other-')); fsx.writeFileSync(pth.join(other, 'keep.txt'), 'x');
  assert.throws(() => build(src, other), /not empty/); assert.ok(fsx.existsSync(pth.join(other, 'keep.txt')));
});

test('append refuses to touch an encrypted note', async () => {
  const s = await start();
  try {
    const env = '-----BEGIN PLAINNOTE ENCRYPTED NOTE-----\nVersion: 1\n\nAAAA\n-----END PLAINNOTE ENCRYPTED NOTE-----\n';
    await s.put('vault', env);
    const r = await s.j('/api/append', { method: 'POST', body: JSON.stringify({ name: 'vault', text: 'plain capture' }) });
    assert.equal(r.status, 409); assert.match(r.body.error, /encrypted/);
    assert.equal(await (await fetch(`${s.base}/api/notes`)).json().then((l) => l.find((n) => n.name === 'vault').text), env);      // untouched
    assert.equal((await s.j('/api/append', { method: 'POST', body: JSON.stringify({ name: 'normal', text: 'ok' }) })).status, 200);
  } finally { s.stop(); }
});

test('publish and PDF export refuse encrypted notes', async () => {
  const fsx = require('fs'), os = require('os'), pth = require('path');
  const { build } = require('../scripts/publish'), pdf = require('../scripts/export-pdf');
  const env = '-----BEGIN PLAINNOTE ENCRYPTED NOTE-----\nVersion: 1\n\nAAAA\n-----END PLAINNOTE ENCRYPTED NOTE-----\n';
  const src = fsx.mkdtempSync(pth.join(os.tmpdir(), 'pn-enc-src-')), out = pth.join(fsx.mkdtempSync(pth.join(os.tmpdir(), 'pn-enc-out-')), 'site');
  fsx.writeFileSync(pth.join(src, 'Public.md'), '# Public'); fsx.writeFileSync(pth.join(src, 'Vault.md'), env);
  const r = build(src, out); assert.equal(r.pages, 1); assert.deepEqual(r.skipped, ['Vault']);
  assert.ok(!fsx.existsSync(pth.join(out, 'Vault.html'))); assert.ok(!fsx.readFileSync(pth.join(out, 'index.html'), 'utf8').includes('Vault'));
  await assert.rejects(pdf.run([pth.join(src, 'Vault.md')]), /encrypted/);
});

test('deleting a note returns its trash id, and that id restores it', async () => {
  const s = await start();
  try {
    await s.put('Plan', 'precious');
    const del = await s.j('/api/note?name=Plan', { method: 'DELETE' });
    assert.equal(del.status, 200); assert.match(del.body.id, /^\d+__Plan\.md$/); assert.ok(!fs.existsSync(path.join(s.dir, 'Plan.md')));
    const back = await s.j('/api/restore', { method: 'POST', body: JSON.stringify({ id: del.body.id }) });
    assert.equal(back.status, 200); assert.equal(back.body.name, 'Plan'); assert.equal(fs.readFileSync(path.join(s.dir, 'Plan.md'), 'utf8'), 'precious');
  } finally { s.stop(); }
});

test('metadata listing and batch read: names and mtimes only, then just the bodies asked for', async () => {
  const s = await start();
  try {
    await s.put('A', 'alpha'); await s.put('sub/B', 'beta'); fs.writeFileSync(path.join(s.dir, '.hidden.md'), 'x');
    const meta = (await s.j('/api/notes?meta=1')).body;
    assert.deepEqual(meta.map((m) => m.name).sort(), ['A', 'sub/B']); for (const m of meta) { assert.equal(typeof m.mtime, 'number'); assert.equal('text' in m, false, 'no file contents in the listing'); }
    const read = async (names) => s.j('/api/notes/read', { method: 'POST', body: JSON.stringify({ names }) });
    const r = (await read(['A', 'sub/B', 'Missing', '../../etc/passwd', '/etc/passwd', 'A\0'])).body;
    assert.deepEqual(r.map((n) => [n.name, n.text]).sort(), [['A', 'alpha'], ['sub/B', 'beta']]); assert.equal(r[0].mtime, meta.find((m) => m.name === r[0].name).mtime);
    assert.equal((await read(Array.from({ length: 501 }, (_, i) => 'n' + i))).status, 400);
    assert.equal((await s.j('/api/notes')).body.find((n) => n.name === 'A').text, 'alpha');                 // the full listing is unchanged for older clients
  } finally { s.stop(); }
});

test('the app files are gzipped when accepted and revalidated with an ETag (304), the API is never cached', async () => {
  const s = await start();
  try {
    const plain = await fetch(`${s.base}/app.js`, { headers: { 'Accept-Encoding': 'identity' } }), raw = Buffer.from(await plain.arrayBuffer());
    assert.equal(plain.headers.get('content-encoding'), null); assert.equal(plain.headers.get('cache-control'), 'no-cache'); const tag = plain.headers.get('etag'); assert.match(tag, /^".+"$/);
    const zr = await new Promise((res, rej) => require('node:http').get(`${s.base}/app.js`, { headers: { 'Accept-Encoding': 'gzip' } }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ h: r.headers, b: Buffer.concat(c) })); r.on('error', rej); }));
    assert.equal(zr.h['content-encoding'], 'gzip'); assert.ok(zr.b.length < raw.length / 2, 'much smaller on the wire'); assert.deepEqual(require('node:zlib').gunzipSync(zr.b), raw); assert.match(zr.h.vary, /Accept-Encoding/);
    assert.equal((await fetch(`${s.base}/app.js`, { headers: { 'If-None-Match': tag } })).status, 304);
    assert.equal((await fetch(`${s.base}/app.js`, { headers: { 'If-None-Match': '"stale"' } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/notes?meta=1`)).headers.get('cache-control'), 'no-store');
  } finally { s.stop(); }
});
