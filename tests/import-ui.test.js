// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// The in-app importer, driven through its real file inputs in headless Chrome (skipped when Chrome isn't installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));

function zip(entries) {
  const parts = [], cd = []; let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data), name = Buffer.from(e.name), comp = zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(lh, name, comp); cd.push(c, name); off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

test('in-app import: Notion zip and Evernote .enex, with conflicts, attachments and links', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const vault = mk('plainnote-imp-vault-'), tmp = mk('plainnote-imp-src-'), prof = mk('plainnote-imp-prof-');
  fs.mkdirSync(path.join(vault, 'Imported')); fs.writeFileSync(path.join(vault, 'Mine.md'), 'mine'); fs.writeFileSync(path.join(vault, 'Imported', 'Project Plan.md'), 'already here');
  const id1 = 'a'.repeat(32), id2 = 'b'.repeat(32), png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), hash = crypto.createHash('md5').update(png).digest('hex');
  const notionZip = path.join(tmp, 'Export.zip');
  fs.writeFileSync(notionZip, zip([{ name: `Project Plan ${id1}.md`, data: `# Project Plan\n\nSee [Design Notes](Project%20Plan%20${id1}/Design%20Notes%20${id2}.md) ![shot](Project%20Plan%20${id1}/shot.png)` },
    { name: `Project Plan ${id1}/Design Notes ${id2}.md`, data: '# Design Notes\nback' }, { name: `Project Plan ${id1}/shot.png`, data: png }, { name: 'song.mp3', data: 'x' }]));
  const enexFile = path.join(tmp, 'Travel.enex');
  fs.writeFileSync(enexFile, `<?xml version="1.0"?><en-export><note><title>Trip</title><content><![CDATA[<en-note><div><en-todo checked="true"/>Passport</div><div><en-media hash="${hash}" type="image/png"/></div></en-note>]]></content><created>20240305T101500Z</created><tag>travel</tag><resource><data encoding="base64">${png.toString('base64')}</data><mime>image/png</mime><resource-attributes><file-name>map.png</file-name></resource-attributes></resource></note></en-export>`);

  const [port, dport] = [await free(), await free()];
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), vault, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] });
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
    const until = async (expr, what) => { for (let i = 0; i < 80; i++) { if (await ev(expr)) return; await sleep(150); } throw new Error('timeout: ' + what); };
    const pick = async (sel, file) => { const doc = (await cdp('DOM.getDocument')).result.root.nodeId, n = (await cdp('DOM.querySelector', { nodeId: doc, selector: sel })).result.nodeId; await cdp('DOM.setFileInputFiles', { nodeId: n, files: [file] }); };
    await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('DOM.enable');
    await cdp('Page.navigate', { url: `http://localhost:${port}/` }); await sleep(1500);
    await ev("localStorage.tourSeen='1'");

    // 1. Notion zip into the "Imported" folder, where a note of the same name already exists
    await ev('openImport()'); await pick('#impfi', notionZip);
    await until("document.querySelector('#impsum').textContent.includes('Found')", 'summary');
    const sum = await ev("document.querySelector('#impsum').textContent");
    assert.match(sum, /Found 2 notes and 1 image\/PDF file/); assert.match(sum, /\.mp3 × 1/);
    await ev("document.querySelector('#impgo2').click()"); await until("document.querySelector('#impsum').textContent.includes('Imported 2 notes')", 'import done');
    assert.equal(fs.readFileSync(path.join(vault, 'Imported', 'Project Plan.md'), 'utf8'), 'already here');           // never overwritten
    const plan2 = fs.readFileSync(path.join(vault, 'Imported', 'Project Plan 2.md'), 'utf8');
    assert.match(plan2, /\[\[Imported\/Project Plan\/Design Notes\|Design Notes\]\]|\[\[Imported\/Project Plan\/Design Notes\]\]/);
    const shot = /!\[shot\]\((attachments\/[^)]+)\)/.exec(plan2); assert.ok(shot, plan2); assert.ok(fs.existsSync(path.join(vault, shot[1])));
    assert.ok(fs.existsSync(path.join(vault, 'Imported', 'Project Plan', 'Design Notes.md')));
    assert.ok(await ev("notes.has('Imported/Project Plan 2')"));                                                       // the sidebar knows about it
    await ev("document.querySelector('#impx').click()");

    // 2. Evernote, merged into the root of the vault
    await ev('openImport()'); await pick('#impfi', enexFile);
    await until("document.querySelector('#impsum').textContent.includes('Found')", 'enex summary');
    assert.match(await ev("document.querySelector('#impsum').textContent"), /Found 1 note and 1 image\/PDF file \(including 1 Evernote file\)/);
    await ev("document.querySelector('#impto').value=''"); await ev("document.querySelector('#impgo2').click()"); await until("document.querySelector('#impsum').textContent.includes('Imported 1 note')", 'enex done');
    const trip = fs.readFileSync(path.join(vault, 'Travel', 'Trip.md'), 'utf8');
    assert.match(trip, /^---\ncreated: 2024-03-05\ntags: travel\n---\n\n# Trip\n\n- \[x\] Passport\n\n!\[map\]\(attachments\/[^)]+map\.png\)/);
    assert.equal(fs.readFileSync(path.join(vault, 'Mine.md'), 'utf8'), 'mine');
    await ev("document.querySelector('#impsum button').click()"); await sleep(500);
    assert.equal(await ev('cur'), 'Travel/Trip');                                                                      // "Open the first note"
    assert.equal(await ev("document.querySelector('#impdlg')"), null);
    assert.deepEqual(errors, []);
  } finally { try { ws?.close(); } catch {} chrome.kill(); server.kill(); }
});
