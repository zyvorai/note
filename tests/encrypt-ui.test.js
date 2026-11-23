// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Encrypted notes end to end in headless Chrome: what is on disk, what the app shows, and every way it could leak or lose data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const C = require('../public/crypto.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));

test('encrypted notes: encrypt, edit, lock, unlock, and nothing leaks or is lost', { skip: !CHROME && 'Chrome not found', timeout: 120000 }, async () => {
  const vault = mk('plainnote-enc-v-'), prof = mk('plainnote-enc-p-');
  fs.writeFileSync(path.join(vault, 'Diary.md'), '# Diary\n\nthe zebra password is hunter2\n');
  fs.writeFileSync(path.join(vault, 'Other.md'), '# Other\n\n![[Diary]]\n\nand a [[Diary]] link\n');
  const [port, dport] = [await free(), await free()];
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), vault, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((res) => server.stdout.on('data', (d) => /Open:/.test(d) && res()));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${dport}`, `--user-data-dir=${prof}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
  let ws;
  const disk = (n) => fs.readFileSync(path.join(vault, n + '.md'), 'utf8');
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
    const answer = async (a, b) => { await until("!!document.querySelector('#passdlg')", 'passphrase dialog'); await ev(`document.querySelector('#pd1').value=${JSON.stringify(a)};const p2=document.querySelector('#pd2');if(p2)p2.value=${JSON.stringify(b ?? a)};document.querySelector('#passdlg form').requestSubmit()`); };
    const type = async (text) => { await ev(`(()=>{const e=document.querySelector('#ed');e.value=${JSON.stringify(text)};onInput();})()`); await ev('flush()'); };
    await cdp('Runtime.enable'); await cdp('Page.enable');
    await cdp('Page.navigate', { url: `http://localhost:${port}/` }); for (let i = 0; i < 150; i++) { try { if (await ev("typeof plainnote !== 'undefined'")) break; } catch {} await sleep(100); } await ev('plainnote.ready.then(() => true)'); await ev("localStorage.tourSeen='1'");
    await ev("open('Diary', false)"); await until("cur==='Diary' && !!document.querySelector('#ed')", 'diary open');

    // encrypt: validation first, then success
    await ev('void encryptNote()'); await answer('short'); assert.match(await ev("document.querySelector('#pde').textContent"), /at least 8/);
    await ev("document.querySelector('#pd1').value='longenough1';document.querySelector('#pd2').value='different22';document.querySelector('#passdlg form').requestSubmit()"); assert.match(await ev("document.querySelector('#pde').textContent"), /different/);
    assert.equal(disk('Diary').includes('zebra'), true, 'nothing encrypted yet after failed attempts');
    await ev("document.querySelector('#pd2').value='longenough1';document.querySelector('#passdlg form').requestSubmit()");
    await until("notes.get('Diary').enc", 'encrypted');
    assert.ok(C.isEnvelope(disk('Diary'))); assert.ok(!/zebra|hunter2/.test(disk('Diary')));
    assert.equal((await C.decrypt(disk('Diary'), 'longenough1')).text, '# Diary\n\nthe zebra password is hunter2\n');

    // editing while unlocked re-encrypts on save, with a fresh IV each time
    const iv1 = /IV: (.*)/.exec(disk('Diary'))[1];
    await type('# Diary\n\nthe zebra password is now correcthorse\n');
    assert.ok(!/correcthorse/.test(disk('Diary'))); assert.notEqual(/IV: (.*)/.exec(disk('Diary'))[1], iv1);
    assert.equal((await C.decrypt(disk('Diary'), 'longenough1')).text, '# Diary\n\nthe zebra password is now correcthorse\n');

    // version history: encrypted versions are decrypted for preview and restore (never restored as an envelope); foreign-passphrase ones are refused
    const hist = path.join(vault, '.plainnote', 'history', 'Diary'); fs.mkdirSync(hist, { recursive: true });
    const olderPlain = '# Diary\n\nthe zebra password is now correcthorse\n';
    fs.writeFileSync(path.join(hist, '1000000000001.md'), (await C.encryptWithPassphrase('x', 'some other passphrase')).envelope);        // different passphrase
    fs.writeFileSync(path.join(hist, '1000000000002.md'), disk('Diary'));                                                                  // same key as the open note
    await type('# Diary\n\nnewer text after the snapshot\n');
    await ev('void openHistory()'); await until("document.querySelectorAll('#hist li[data-id]').length >= 2", 'history list');
    await ev("document.querySelector('#hist li[data-id=\"1000000000001\"]').click()"); await until("document.querySelector('#hpre').textContent.includes('different passphrase')", 'foreign version message');
    assert.equal(await ev("document.querySelector('#hr').disabled"), true);
    await ev("document.querySelector('#hist li[data-id=\"1000000000002\"]').click()"); await until("document.querySelector('#hpre').textContent.includes('correcthorse')", 'decrypted preview');
    assert.ok(!(await ev("document.querySelector('#hpre').textContent")).includes('BEGIN PLAINNOTE'));
    await ev("document.querySelector('#hr').click()");
    await until("!dirty && document.querySelector('#status').textContent === 'Saved'", 'restored version saved');       // wait for the autosave rather than racing it
    assert.equal(await ev("notes.get('Diary').text"), olderPlain);
    assert.equal((await C.decrypt(disk('Diary'), 'longenough1')).text, olderPlain);                                                         // encrypted once, not twice

    // while unlocked the app can search it; embeds elsewhere never show it
    await ev("document.querySelector('#q').value='correcthorse';document.querySelector('#q').dispatchEvent(new Event('input'))"); await sleep(200);
    assert.ok(await ev("[...document.querySelectorAll('#list .item')].some(i=>i.dataset.note==='Diary')"));
    await ev("document.querySelector('#q').value='';document.querySelector('#q').dispatchEvent(new Event('input'))");
    await ev("open('Other', false)"); await until("cur==='Other'", 'other'); await ev("preview=true;renderPane()");
    const pv = await ev("document.querySelector('#pv').innerHTML"); assert.match(pv, /Encrypted note/); assert.ok(!/correcthorse/.test(pv));
    assert.ok(await ev("document.querySelector('#list .item[data-note=\"Diary\"]').textContent.includes('🔒')"));      // lock icon in the list

    // lock: text gone from memory, search finds nothing, the pane asks for the passphrase
    await ev("open('Diary', false)"); await until("cur==='Diary'", 'diary'); await ev("lockNote('Diary')"); await until("!!document.querySelector('.lockcard')", 'lock card');
    assert.equal(await ev("notes.get('Diary').text"), ''); assert.equal(await ev("notes.get('Diary').enc"), null);
    await ev("document.querySelector('#q').value='correcthorse';document.querySelector('#q').dispatchEvent(new Event('input'))"); await sleep(200);
    assert.ok(!(await ev("[...document.querySelectorAll('#list .item')].some(i=>i.dataset.note==='Diary')"))); await ev("document.querySelector('#q').value='';document.querySelector('#q').dispatchEvent(new Event('input'))");
    for (let i = 0; i < 30 && (await ev("document.body.innerText")).includes('correcthorse'); i++) await sleep(100);   // the cleared search repaints after its debounce
    assert.ok(!(await ev("document.body.innerText")).includes('correcthorse'), 'plaintext is not anywhere on the page');

    // wrong passphrase, then the right one
    await ev("document.querySelector('#lkp').value='wrong passphrase';document.querySelector('#lkf').requestSubmit()"); await until("document.querySelector('#lke').textContent.includes('Wrong passphrase')", 'wrong passphrase message');
    assert.ok(await ev("!!document.querySelector('.lockcard')"));
    await ev("document.querySelector('#lkp').value='longenough1';document.querySelector('#lkf').requestSubmit()"); await until("!!document.querySelector('#ed') && document.querySelector('#ed').value.includes('correcthorse')", 'unlocked');

    // a locked note can never be overwritten by a stray save, find-and-replace or duplicate
    await ev("lockNote('Diary')"); await until("!!document.querySelector('.lockcard')", 'locked again');
    const before = disk('Diary');
    await ev('void openHistory()'); await sleep(300); assert.ok(!(await ev("!!document.querySelector('#hist')")), 'no history panel for a locked note');
    await ev("(async()=>{try{await putNote(notes.get('Diary'),'oops',0)}catch(e){window.__e=e.message}})()"); assert.match(await ev('window.__e'), /locked/); assert.equal(disk('Diary'), before);
    await ev("document.querySelector('#gfq').value='zebra';gfRender();"); assert.ok(!(await ev("gfHits.some(h=>h.name==='Diary')")));
    await ev("duplicateNote('Diary')"); await until("cur==='Diary copy'", 'duplicate'); assert.equal(disk('Diary copy'), before);      // an identical, still-encrypted copy
    assert.ok(await ev("isLocked(notes.get('Diary copy'))"));
    assert.equal((await C.decrypt(disk('Diary copy'), 'longenough1')).text.includes('correcthorse'), true);

    // after a reload every encrypted note is locked again; the key lived only in memory
    await cdp('Page.navigate', { url: `http://localhost:${port}/` }); for (let i = 0; i < 150; i++) { try { if (await ev("typeof plainnote !== 'undefined'")) break; } catch {} await sleep(100); } await ev('plainnote.ready.then(() => true)');
    assert.ok(await ev("isLocked(notes.get('Diary'))")); assert.equal(await ev("keyring.size"), 0);

    // changing the passphrase, renaming while unlocked, idle lock
    await ev("open('Diary', false)"); await until("!!document.querySelector('.lockcard')", 'lock card after reload');
    await ev("document.querySelector('#lkp').value='longenough1';document.querySelector('#lkf').requestSubmit()"); await until("!!document.querySelector('#ed')", 'unlocked 2');
    await ev('void changePassphrase()'); await answer('brand new passphrase'); await until("notes.get('Diary').cipher && !!notes.get('Diary').enc && !document.querySelector('#passdlg')", 'changed'); await sleep(400);
    await assert.rejects(C.decrypt(disk('Diary'), 'longenough1'), /Wrong passphrase/); assert.ok((await C.decrypt(disk('Diary'), 'brand new passphrase')).text.includes('correcthorse'));
    await ev("renameNote('Diary','Journal')"); await until("notes.has('Journal')", 'renamed'); await sleep(300);
    assert.ok(await ev("!!notes.get('Journal').enc"), 'still unlocked after rename'); assert.ok(!fs.existsSync(path.join(vault, 'Diary.md')));
    assert.match(disk('Other'), /\[\[Journal\]\]/);                                                                              // links were updated, and that note stayed readable
    await ev("lastAct = Date.now() - 11 * 60000; idleCheck()"); await until("isLocked(notes.get('Journal'))", 'idle lock');

    // appending (quick capture) is refused for an encrypted note
    const r = await ev("fetch('/api/append',{method:'POST',body:JSON.stringify({name:'Journal',text:'x'})}).then(r=>r.status)"); assert.equal(r, 409);

    // removing encryption restores plain text
    await ev("open('Journal', false)"); await until("!!document.querySelector('.lockcard')", 'lock'); await ev("document.querySelector('#lkp').value='brand new passphrase';document.querySelector('#lkf').requestSubmit()"); await until("!!document.querySelector('#ed')", 'unlocked 3');
    await ev('void removeEncryption()'); await until("!!document.querySelector('#dlg-ok')", 'remove-encryption confirmation'); await ev("document.querySelector('#dlg-ok').click()"); await until("!notes.get('Journal').cipher", 'decrypted'); await sleep(300);
    assert.ok(!C.isEnvelope(disk('Journal'))); assert.match(disk('Journal'), /correcthorse/);
    assert.deepEqual(errors, []);
  } finally { try { ws?.close(); } catch {} chrome.kill(); server.kill(); }
});
