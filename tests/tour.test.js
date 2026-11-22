// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// First-run tour, driven in headless Chrome over the DevTools protocol (skipped when Chrome isn't installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));

test('first-run tour: auto-starts only for an empty folder, adds sample notes safely, can be skipped and retaken', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const dirE = mk('plainnote-tour-e-'), dirF = mk('plainnote-tour-f-'), prof = mk('plainnote-tour-p-');
  fs.writeFileSync(path.join(dirF, 'Mine.md'), '# Mine\nhello');
  const [pe, pf, dport] = [await free(), await free(), await free()];
  const srv = (d, p) => { const s = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), d, String(p)], { stdio: ['pipe', 'pipe', 'inherit'] }); return new Promise((res) => s.stdout.on('data', (x) => /Open:/.test(x) && res(s))); };
  const servers = [await srv(dirE, pe), await srv(dirF, pf)];
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
    const key = async (k) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, windowsVirtualKeyCode: { Escape: 27, ArrowRight: 39, ArrowLeft: 37 }[k] }); };
    const state = () => ev("(()=>{const t=document.querySelector('#tour');return t?{title:t.querySelector('#ttl').textContent,buttons:[...t.querySelectorAll('.tact button')].map(b=>b.textContent),spot:getComputedStyle(t.querySelector('.thl')).display==='block'}:null})()");
    const go = async (port) => { await cdp('Page.navigate', { url: `http://localhost:${port}/` }); for (let i = 0; i < 150; i++) { try { if (await ev("typeof plainnote !== 'undefined'")) break; } catch {} await sleep(100); } await ev('plainnote.ready.then(() => true)'); };
    await cdp('Runtime.enable'); await cdp('Page.enable');

    await go(pe);                                                      // empty folder, never seen: starts by itself
    let s = await state(); assert.equal(s.title, 'Welcome to Plainnote'); assert.deepEqual(s.buttons, ['Skip', 'Add sample notes', 'Just the tour']);
    await ev("[...document.querySelectorAll('#tour .tact button')].find(b=>b.textContent==='Add sample notes').click()"); await sleep(1200);
    assert.ok(fs.existsSync(path.join(dirE, 'Welcome.md')) && fs.existsSync(path.join(dirE, 'Getting started', 'Your files.md')));
    assert.equal(await ev('cur'), 'Welcome');
    s = await state(); assert.equal(s.title, 'Search everything'); assert.equal(s.spot, true);   // advanced and spotlights the search box
    for (const want of ['New note', 'Write, then read', 'See how ideas connect', 'Everything else is in the palette']) { await key('ArrowRight'); await sleep(200); assert.equal((await state()).title, want); }
    await key('ArrowLeft'); await sleep(150); assert.equal((await state()).title, 'See how ideas connect');
    await key('Escape'); await sleep(150); assert.equal(await state(), null);                  // Esc closes and remembers
    assert.equal(await ev('localStorage.tourSeen'), '1');
    await go(pe); assert.equal(await state(), null);                                           // not shown again

    // every link in the samples points at a sample note (except the deliberate "My first idea" example)
    const bad = await ev(`(()=>{const S=PNTour.samples(),names=S.map(n=>n.name.split('/').pop().toLowerCase());const out=[];for(const n of S)for(const m of n.text.replace(/\`[^\`]*\`/g,'').matchAll(/\\[\\[([^\\]|#]+)/g))if(!names.includes(m[1].trim().toLowerCase())&&m[1]!=='My first idea')out.push(n.name+' -> '+m[1]);return out})()`);
    assert.deepEqual(bad, []);
    assert.equal(await ev('PNTour.createSamples(false)'), 0);                                  // never overwrites what is already there

    await ev("localStorage.removeItem('tourSeen')"); await go(pe); assert.equal(await state(), null);   // has notes now: no auto-start
    await ev('PNTour.start()'); await sleep(200); s = await state(); assert.equal(s.title, 'Welcome to Plainnote'); assert.deepEqual(s.buttons, ['Skip', 'Next']);       // no sample-notes button once there are notes
    await key('Escape');

    await go(pf); assert.equal(await state(), null);                                           // existing notes, never seen: leave them alone
    assert.deepEqual(errors, []);
  } finally { try { ws?.close(); } catch {} chrome.kill(); servers.forEach((x) => x.kill()); }
});
