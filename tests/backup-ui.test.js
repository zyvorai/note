// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Backup and restore through the real UI in headless Chrome (skipped when Chrome isn't installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));

test('backup download, desktop save, and restore dialog', { skip: !CHROME && 'Chrome not found', timeout: 120000 }, async () => {
  const src = mk('pn-bkui-src-'), vault = mk('pn-bkui-v-'), downloads = mk('pn-bkui-dl-'), saved = mk('pn-bkui-saved-'), prof = mk('pn-bkui-p-');
  fs.mkdirSync(path.join(src, 'Projects')); fs.writeFileSync(path.join(src, 'One.md'), '# One from the backup'); fs.writeFileSync(path.join(src, 'Projects', 'Plan.md'), 'plan'); fs.writeFileSync(path.join(src, 'Same.md'), 'same text');
  const zipPath = path.join(mk('pn-bkui-z-'), 'backup.zip'); assert.equal(spawnSync(process.execPath, [SERVER, 'backup', src, zipPath]).status, 0);
  fs.writeFileSync(path.join(vault, 'Mine.md'), '# Mine'); fs.writeFileSync(path.join(vault, 'One.md'), '# One, edited since'); fs.writeFileSync(path.join(vault, 'Same.md'), 'same text');
  const [port, dport] = [await free(), await free()];
  const server = spawn(process.execPath, [SERVER, vault, String(port)], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PLAINNOTE_BACKUP_DIR: saved } });
  await new Promise((res) => server.stdout.on('data', (d) => /Open:/.test(d) && res()));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${dport}`, `--user-data-dir=${prof}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${dport}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(250); }
    assert.ok(target, 'chrome started');
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map(), errors = [];
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
    const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
    const until = async (expr, what) => { for (let i = 0; i < 100; i++) { if (await ev(expr)) return; await sleep(150); } throw new Error('timeout: ' + what); };
    await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('DOM.enable'); await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await cdp('Page.navigate', { url: `http://localhost:${port}/` }); await sleep(1500); await ev("localStorage.tourSeen='1'");

    // 1. a normal browser downloads the zip
    await ev('void downloadBackup()');
    let dl; for (let i = 0; i < 60 && !dl; i++) { dl = fs.readdirSync(downloads).find((f) => /^plainnote-backup-.*\.zip$/.test(f)); if (!dl) await sleep(200); }
    assert.ok(dl, 'a backup file was downloaded');
    const got = fs.readFileSync(path.join(downloads, dl)); assert.equal(got.subarray(0, 2).toString(), 'PK'); for (const n of ['Mine.md', 'One.md', 'Same.md']) assert.ok(got.includes(Buffer.from(n)), n);
    const t = spawnSync('unzip', ['-tq', path.join(downloads, dl)], { encoding: 'utf8' }); if (!t.error) assert.equal(t.status, 0, t.stdout);

    // 2. the Mac app's window: the server writes it to the Downloads folder instead
    await ev('window.webkit = { messageHandlers: { mac: {} } }; void downloadBackup()'); await until("document.querySelector('#status').textContent.startsWith('Backup saved to')", 'desktop save');
    assert.equal(fs.readdirSync(saved).length, 1); assert.ok((await ev("document.querySelector('#status').textContent")).includes(saved));
    await ev('delete window.webkit');

    // 3. the iPhone app has no server to ask
    await ev("document.documentElement.classList.add('ios'); void downloadBackup()"); await sleep(200);
    assert.match(await ev("document.querySelector('#status').textContent"), /iPhone app/); await ev("document.documentElement.classList.remove('ios')");

    // 4. restore: preview first, then add; the edited note is kept, the backup's version lands beside it
    await ev('openRestore()');
    const doc = (await cdp('DOM.getDocument')).result.root.nodeId, node = (await cdp('DOM.querySelector', { nodeId: doc, selector: '#bkfi' })).result.nodeId;
    await cdp('DOM.setFileInputFiles', { nodeId: node, files: [zipPath] });
    await until("document.querySelector('#bksum').textContent.includes('This backup holds')", 'dry run summary');
    const prev = await ev("document.querySelector('#bksum').textContent"); assert.match(prev, /holds 3 files/); assert.match(prev, /add 1 new file/); assert.match(prev, /1 already identical/); assert.match(prev, /keep 1 differing file as separate copies/);
    assert.ok(!fs.existsSync(path.join(vault, 'Projects')), 'the preview wrote nothing');
    await ev("document.querySelector('#bkgo2').click()"); await until("document.querySelector('#bksum').textContent.includes('Restored.')", 'restore done');
    assert.equal(fs.readFileSync(path.join(vault, 'One.md'), 'utf8'), '# One, edited since');
    const copy = fs.readdirSync(vault).find((f) => /^One \(restored .*\)\.md$/.test(f)); assert.ok(copy); assert.equal(fs.readFileSync(path.join(vault, copy), 'utf8'), '# One from the backup');
    assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Plan.md'), 'utf8'), 'plan');
    assert.ok(await ev("notes.has('Projects/Plan') && [...notes.keys()].some(k => k.startsWith('One (restored'))"));      // the sidebar is up to date
    await ev("document.querySelector('#bkx').click()"); assert.equal(await ev("document.querySelector('#bakdlg')"), null);

    // 5. a file that is not a backup is refused clearly
    await ev('openRestore()'); fs.writeFileSync(path.join(downloads, 'notes.txt'), 'hello');
    const d2 = (await cdp('DOM.getDocument')).result.root.nodeId, n2 = (await cdp('DOM.querySelector', { nodeId: d2, selector: '#bkfi' })).result.nodeId;
    await cdp('DOM.setFileInputFiles', { nodeId: n2, files: [path.join(downloads, 'notes.txt')] }); await until("document.querySelector('#bksum').textContent.includes('Could not read')", 'bad file message');
    assert.match(await ev("document.querySelector('#bksum').textContent"), /not a Plainnote backup/); assert.equal(await ev("document.querySelector('#bkgo').hidden"), true);
    assert.deepEqual(errors, []);
  } finally { try { ws?.close(); } catch {} chrome.kill(); server.kill(); }
});
