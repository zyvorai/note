// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// The shared dialog behaviour in the real app: focus trap and return, inert background, validated prompts, the folder picker, cancel paths.
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

test('dialogs: overlays trap focus and restore it, prompts validate, folder picker moves notes, cancel leaves things alone', { skip: !CHROME && 'Chrome not found', timeout: 120000 }, async () => {
  const vault = mk('pn-dlg-v-'), prof = mk('pn-dlg-p-');
  fs.mkdirSync(path.join(vault, 'Archive')); fs.mkdirSync(path.join(vault, 'Projects', 'Deep'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Alpha.md'), '# Alpha\n\n![pic](attachments/p.png)\n'); fs.writeFileSync(path.join(vault, 'Beta.md'), 'beta');
  fs.mkdirSync(path.join(vault, 'attachments')); fs.writeFileSync(path.join(vault, 'attachments', 'p.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex'));
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
    const until = async (expr, what) => { for (let i = 0; i < 80; i++) { if (await ev(expr)) return; await sleep(120); } throw new Error('timeout: ' + what); };
    const key = async (k, shift = false) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: { Tab: 9, Escape: 27, Enter: 13, ArrowDown: 40 }[k], modifiers: shift ? 8 : 0, text: type === 'keyDown' && k === 'Enter' ? '\r' : undefined }); };
    const typeInto = async (sel, text) => { await ev(`(()=>{const i=document.querySelector(${JSON.stringify(sel)});i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}))})()`); };
    await cdp('Runtime.enable'); await cdp('Page.enable');
    await cdp('Page.navigate', { url: `http://localhost:${port}/` }); await sleep(1500); await ev("localStorage.tourSeen='1'");
    const inert = () => ev("document.getElementById('app').hasAttribute('inert') && document.getElementById('tabbar').hasAttribute('inert')");

    // the command palette: inert background while open, focus returns to the search box when it closes
    await ev("document.querySelector('#q').focus()"); await ev("swOpen('cmds')"); await sleep(150);
    assert.equal(await inert(), true); assert.equal(await ev("document.activeElement.id"), 'swq');
    await key('Escape'); await sleep(150); assert.equal(await inert(), false); assert.equal(await ev("document.activeElement.id"), 'q');
    assert.equal(await ev("document.querySelector('#sw').getAttribute('aria-modal')"), 'true');

    // settings: Tab cannot leave it, closing returns focus
    await ev("document.querySelector('#q').focus()"); await ev('openSettings()'); await sleep(300); assert.equal(await inert(), true);
    for (let i = 0; i < 12; i++) await key('Tab'); assert.equal(await ev("!!document.activeElement.closest('#st')"), true, 'Tab stays inside settings');
    await key('Tab', true); assert.equal(await ev("!!document.activeElement.closest('#st')"), true);
    await ev("document.querySelector('#stx').click()"); await sleep(150); assert.equal(await inert(), false); assert.equal(await ev("document.activeElement.id"), 'q');

    // rename through the context menu: invalid characters are explained and nothing is renamed; a valid name works; Esc cancels
    const ctx = async (note, label) => { await ev(`document.querySelector('#list [data-note="${note}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:80}))`); await ev(`[...document.querySelectorAll('#ctx button')].find((b)=>b.textContent===${JSON.stringify(label)}).click()`); await until("!!document.querySelector('.dlg')", label + ' dialog'); };
    await ctx('Beta', 'Rename…'); assert.equal(await ev("document.querySelector('.dlg h3').textContent"), 'Rename note'); assert.equal(await ev("document.querySelector('.dlg input').value"), 'Beta');
    await typeInto('.dlg input', 'Be?ta'); await key('Enter'); await sleep(150);
    assert.match(await ev("document.querySelector('.dlg-err').textContent"), /not allowed/); assert.ok(fs.existsSync(path.join(vault, 'Beta.md')));
    await typeInto('.dlg input', '   '); await key('Enter'); await sleep(100); assert.match(await ev("document.querySelector('.dlg-err').textContent"), /Enter a name/);
    await key('Escape'); await sleep(150); assert.equal(await ev("!!document.querySelector('.dlg')"), false); assert.ok(fs.existsSync(path.join(vault, 'Beta.md')));
    await ctx('Beta', 'Rename…'); await typeInto('.dlg input', 'Gamma'); await key('Enter'); await until("notes.has('Gamma') && !notes.has('Beta')", 'renamed');
    assert.ok(fs.existsSync(path.join(vault, 'Gamma.md')) && !fs.existsSync(path.join(vault, 'Beta.md')));

    // move: a searchable folder picker; typing narrows it, Enter moves; a new folder name can be created on the spot
    await ctx('Gamma', 'Move to folder…'); assert.match(await ev("document.querySelector('.dlg h3').textContent"), /Move “Gamma”/);
    assert.deepEqual(await ev("[...document.querySelectorAll('.pf-list li')].map((l) => l.textContent.replace(/current/, '').trim())"), ['Top level', 'Archive', 'Projects', 'Projects/Deep', 'attachments']);
    await typeInto('#pfq', 'deep'); assert.deepEqual(await ev("[...document.querySelectorAll('.pf-list li')].map((l) => l.textContent.trim())").then((a) => a.slice(0, 2)), ['Projects/Deep', 'Create “deep”']);
    assert.equal(await ev("document.querySelector('#pfq').getAttribute('aria-activedescendant')"), 'pf0');
    await key('Enter'); await until("notes.has('Projects/Deep/Gamma')", 'moved into the folder'); assert.ok(fs.existsSync(path.join(vault, 'Projects', 'Deep', 'Gamma.md')));
    await ctx('Projects/Deep/Gamma', 'Move to folder…'); await typeInto('#pfq', 'Fresh/Box'); await key('Enter'); await until("notes.has('Fresh/Box/Gamma')", 'moved into a new folder'); assert.ok(fs.existsSync(path.join(vault, 'Fresh', 'Box', 'Gamma.md')));
    await ctx('Fresh/Box/Gamma', 'Move to folder…'); await typeInto('#pfq', 'bad:name'); await key('Enter'); await sleep(150); assert.match(await ev("document.querySelector('.dlg-err').textContent"), /cannot be empty/); await key('Escape');

    // delete is instant and undoable: the toast's Undo brings the note back where it was
    await ev("open('Alpha', false)"); await until("cur === 'Alpha'", 'alpha'); await ev("document.querySelector('#del').click()"); await until("!notes.has('Alpha')", 'deleted');
    assert.equal(await ev("!!document.querySelector('.dlg')"), false, 'no confirmation dialog'); assert.ok(!fs.existsSync(path.join(vault, 'Alpha.md')));
    await ev("document.querySelector('.toast button').click()"); await until("notes.has('Alpha') && cur === 'Alpha'", 'undo restores and reopens'); assert.ok(fs.existsSync(path.join(vault, 'Alpha.md')));

    // lightbox: a labelled modal; Esc closes and returns focus
    await ev("preview = true; renderPane()"); await until("!!document.querySelector('#pv img')", 'image'); await sleep(300);
    await ev("document.querySelector('#pv img').click()"); await until("!!document.querySelector('#lb')", 'lightbox');
    assert.equal(await ev("document.querySelector('#lb').getAttribute('role')"), 'dialog'); assert.equal(await inert(), true);
    await key('Escape'); await sleep(150); assert.equal(await ev("!!document.querySelector('#lb')"), false); assert.equal(await inert(), false);

    // the migrated dialogs open, trap focus, and close with Esc, returning focus to the opener
    await ev("document.querySelector('#q').focus()");
    for (const [fn, idSel] of [['openClipper()', '#clipdlg'], ['openImport()', '#impdlg'], ['openRestore()', '#bakdlg'], ['openHistory()', '#hist']]) {
      await ev(`void ${fn}`); await until(`!!document.querySelector('${idSel}')`, fn); assert.equal(await ev(`document.querySelector('${idSel}').getAttribute('role')`), 'dialog', fn); assert.equal(await inert(), true, fn);
      assert.equal(await ev(`!!document.activeElement.closest('${idSel}')`), true, fn + ' takes focus');
      await key('Escape'); await sleep(150); assert.equal(await ev(`!!document.querySelector('${idSel}')`), false, fn + ' closes'); assert.equal(await ev("document.activeElement.id"), 'q', fn + ' returns focus');
    }
    // new folder prompt
    await ev('void newFolder("")'); await until("!!document.querySelector('.dlg')", 'new folder'); await typeInto('.dlg input', 'a|b'); await key('Enter'); await sleep(100); assert.match(await ev("document.querySelector('.dlg-err').textContent"), /not allowed/);
    await typeInto('.dlg input', 'Made'); await key('Enter'); await until("folders.includes('Made')", 'folder created'); assert.ok(fs.existsSync(path.join(vault, 'Made')));
    assert.deepEqual(errors, []);
  } finally { try { ws?.close(); } catch {} chrome.kill(); server.kill(); }
});
