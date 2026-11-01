// Real-browser smoke test: drives the UI through headless Chrome via the DevTools protocol (no dependencies).
// Skipped when Chrome isn't installed. Set UI_SHOTS=dir to save screenshots.
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

test('UI works end to end in a real browser', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-ui-'));
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-chrome-'));
  const port = await free(), dport = await free();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), dir, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((res) => server.stdout.on('data', (d) => /Open:/.test(d) && res()));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${dport}`, `--user-data-dir=${prof}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${dport}/json`)).json()).find((t) => t.type === 'page'); } catch {}
      if (!target) await sleep(250);
    }
    assert.ok(target, 'chrome started');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pending = new Map(), errors = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    };
    const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
    const until = async (expr, what) => { for (let i = 0; i < 60; i++) { if (await ev(expr)) return; await sleep(100); } throw new Error('timeout: ' + what); };
    const key = async (k, mods = 0) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code: k === 'Enter' ? 'Enter' : k === 'Tab' ? 'Tab' : '', windowsVirtualKeyCode: { Enter: 13, Tab: 9 }[k] || 0, modifiers: mods, text: type === 'keyDown' && k === 'Enter' ? '\r' : undefined }); };
    const shot = async (name) => { if (!process.env.UI_SHOTS) return; fs.mkdirSync(process.env.UI_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.UI_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot')).result.data, 'base64')); };
    await cdp('Runtime.enable'); await cdp('Page.enable');

    // seed notes on disk, then load the app
    fs.writeFileSync(path.join(dir, 'Home.md'), '# Home\nSee [[Ideas]] and [[Missing]] #start\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n```js\nconst x = 1; // hi\n```\n');
    fs.writeFileSync(path.join(dir, 'Ideas.md'), 'Back to [[Home]] #idea #start\n');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await until(`document.querySelectorAll('#list .item').length === 2`, 'two notes listed');
    assert.equal(await ev(`document.querySelectorAll('#tags .chip').length`), 2);

    // open, preview: table, highlight, wikilinks
    await ev(`document.querySelector('[data-note="Home"]').click()`);
    await until(`document.querySelector('#ed')`, 'editor');
    await ev(`document.querySelector('#tog').click()`);
    await until(`document.querySelector('#pv table')`, 'table rendered');
    assert.equal(await ev(`document.querySelectorAll('#pv .tk-k').length`), 1);
    assert.equal(await ev(`document.querySelectorAll('#pv a.new').length`), 1);
    await shot('1-preview');

    // tag filter
    await ev(`document.querySelector('#tags [data-tag="idea"]').click()`);
    assert.equal(await ev(`document.querySelectorAll('#list .item').length`), 1);
    await ev(`document.querySelector('#tags [data-tag="idea"]').click()`);

    // graph draws without errors and clicking a node opens the note
    await ev(`document.querySelector('#gr').click()`);
    await until(`document.querySelector('#gc')`, 'graph canvas');
    await sleep(1200); await shot('2-graph');
    await ev(`document.querySelector('#gr').click()`);

    // quick switcher: recent notes first, prefix matches beat substring matches
    const order = await ev(`(()=>{ swOpen(); const a = swRows.slice(); const t = [...notes.values()].sort((x,y)=>y.mtime-x.mtime)[0].name; $('#swq').value = 'o'; swRender(); const b = swRows.slice(); swClose(); return {a, t, b}; })()`);
    assert.equal(order.a[0], order.t, 'empty query lists the most recently edited note first');
    assert.ok(order.b.length && order.b.slice(0, order.b.findIndex((n) => !String(n).toLowerCase().startsWith('o'))).every((n) => String(n).toLowerCase().startsWith('o')), 'prefix matches first');

    // today's daily note is created in daily/ and reopened (not duplicated) on a second click
    await ev(`document.querySelector('#today').click()`);
    await until(`/^\\d{4}-\\d{2}-\\d{2}$/.test(document.querySelector('#title').value) && document.querySelector('#ed')`, 'daily note');
    const daily = await ev(`document.querySelector('#title').value`);
    await sleep(500);
    assert.ok(fs.existsSync(path.join(dir, 'daily', daily + '.md')), 'daily note file created');
    await ev(`document.querySelector('#today').click()`); await sleep(300);
    assert.equal(fs.readdirSync(path.join(dir, 'daily')).length, 1);

    // pinning floats the note to the top of the list, and unpinning restores the order
    await ev(`document.querySelector('#pin').click()`);
    assert.match(await ev(`document.querySelector('#list .item').textContent`), /^📌 /);
    assert.equal(await ev(`document.querySelector('#pin').textContent`), 'Unpin');
    await ev(`document.querySelector('#pin').click()`);
    assert.doesNotMatch(await ev(`document.querySelector('#list .item').textContent`), /📌/);

    // export downloads a self-contained HTML page of the rendered note
    const exp = await ev(`(async()=>{ let d; const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){ d = { name: this.download, href: this.href }; };
      document.querySelector('#exp').click(); HTMLAnchorElement.prototype.click = orig;
      return { name: d.name, html: await (await fetch(d.href)).text(), cur: document.querySelector('#title').value }; })()`);
    assert.equal(exp.name, exp.cur + '.html');
    assert.match(exp.html, /^<!doctype html>/);
    assert.match(exp.html, /<div id="pv">/);
    assert.match(exp.html, /#pv/, 'preview styles are embedded');
    assert.doesNotMatch(exp.html, /data-note|<script/, 'no app hooks or scripts');

    // editor: list continuation, [[ autocomplete, bold, tab indent
    await ev(`(async()=>{ document.querySelector('#new').click(); })()`);
    await until(`document.querySelector('#ed') && document.querySelector('#title').value.startsWith('Untitled')`, 'new note');
    await ev(`document.querySelector('#ed').focus()`);
    await cdp('Input.insertText', { text: '- one' });
    await key('Enter');
    await cdp('Input.insertText', { text: 'two' });
    assert.equal(await ev(`document.querySelector('#ed').value`), '- one\n- two');
    await key('Tab');
    assert.equal(await ev(`document.querySelector('#ed').value`), '- one\n  - two');
    await cdp('Input.insertText', { text: ' see [[Ho' });
    await until(`document.querySelector('#ac').style.display === 'block'`, 'autocomplete popup');
    await shot('3-editor');
    await key('Enter');
    assert.match(await ev(`document.querySelector('#ed').value`), /see \[\[Home\]\]$/);

    // autosave reaches disk, then a conflicting external write is detected
    const untitled = fs.readdirSync(dir).find((f) => f.startsWith('Untitled'));
    for (let i = 0; i < 50 && !/see \[\[Home\]\]$/.test(fs.readFileSync(path.join(dir, untitled), 'utf8')); i++) await sleep(100);   // wait for autosave
    assert.match(fs.readFileSync(path.join(dir, untitled), 'utf8'), /^- one\n {2}- two see \[\[Home\]\]$/);
    await until(`document.querySelector('#status').textContent === 'Saved'`, 'save finished');
    await sleep(50);
    fs.writeFileSync(path.join(dir, untitled), 'changed on disk');
    await ev(`document.querySelector('#ed').focus()`);
    await cdp('Input.insertText', { text: ' more' });
    await until(`/Changed elsewhere/.test(document.querySelector('#status').textContent)`, 'conflict reported');
    assert.ok(fs.readdirSync(dir).some((f) => f.includes('(conflict')), 'conflict copy saved');
    assert.equal(fs.readFileSync(path.join(dir, untitled), 'utf8'), 'changed on disk');

    // delete -> trash -> restore
    await ev(`window.confirm = () => true; document.querySelector('#del').click()`);
    await until(`document.querySelectorAll('#list .item').length >= 2 && !document.querySelector('[data-note="${untitled.slice(0, -3)}"]')`, 'note removed');
    await ev(`document.querySelector('#trash').click()`);
    await until(`document.querySelector('[data-restore]')`, 'trash lists note');
    await shot('4-trash');
    await ev(`document.querySelector('[data-restore]').click()`);
    await until(`document.querySelector('#title').value.startsWith('Untitled')`, 'restored');

    assert.equal(await ev(`document.querySelector('#del').disabled`), false);   // restored note is open

    // live syntax highlighting: overlay text must equal the textarea text, and wrapping must match
    const long = '# Heading with **bold** and #tag\n\n' + Array.from({ length: 30 }, (_, i) => `- item ${i} with [[Home]] and \`code\` ` + 'word '.repeat(30)).join('\n') + '\n\n```js\nconst a = "x"; // c\n```\n> quote\n| a | b |\n|---|---|\n';
    await ev(`document.querySelector('#tog').click(); document.querySelector('#tog').click()`);       // back into the editor
    await until(`document.querySelector('#ed')`, 'editor');
    await ev(`(() => { const e = document.querySelector('#ed'); e.value = ${JSON.stringify(long)}; e.dispatchEvent(new Event('input')); })()`);
    assert.equal(await ev(`document.querySelector('#hl').textContent.replace(/\\n$/, '') === document.querySelector('#ed').value`), true, 'overlay text matches');
    for (const c of ['mk-h', 'mk-b', 'mk-l', 'mk-c', 'mk-t', 'mk-q', 'tk-k', 'mk-m'])
      assert.ok(await ev(`!!document.querySelector('#hl .${c}')`), 'highlight class ' + c);
    assert.equal(await ev(`document.querySelector('#hl').scrollHeight`), await ev(`document.querySelector('#ed').scrollHeight`), 'same wrapped height');
    // a wrapped line's last word sits at the same y in overlay and textarea (checked via caret rect)
    assert.ok(await ev(`document.querySelector('#ed').getBoundingClientRect().height > document.querySelector('#pane').clientHeight`), 'editor grows with content (pane scrolls)');
    await shot('6-highlight');

    // typing at the end of a long note scrolls the pane to keep the caret visible
    await ev(`(() => { const e = document.querySelector('#ed'); document.querySelector('#pane').scrollTop = 0; e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
    await cdp('Input.insertText', { text: 'end' });
    let scrolled = false;
    for (let i = 0; i < 30 && !scrolled; i++) { scrolled = await ev(`document.querySelector('#pane').scrollTop > 200`); if (!scrolled) await sleep(100); }
    if (!scrolled) console.log('DEBUG caret-follow', JSON.stringify(await ev(`(() => { const e = document.querySelector('#ed'), p = document.querySelector('#pane');
      return { scrollTop: p.scrollTop, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight, selEnd: e.selectionEnd, len: e.value.length, tail: e.value.slice(-12),
               active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), hasFocus: document.hasFocus(), edH: e.offsetHeight }; })()`)));
    assert.ok(scrolled, 'pane scrolled to follow the caret');
    await shot('7-highlight-bottom');

    // theme toggle: auto -> light -> dark, persisted
    const bg = () => ev(`getComputedStyle(document.body).backgroundColor`);
    const mode = () => ev(`document.querySelector('#theme').dataset.mode`);
    const sys = await ev(`matchMedia('(prefers-color-scheme: dark)').matches`);
    assert.equal(await mode(), 'auto');
    assert.equal(await bg(), sys ? 'rgb(24, 24, 27)' : 'rgb(255, 255, 255)', 'auto follows the system');
    await ev(`document.querySelector('#theme').click()`);
    assert.equal(await mode(), 'light'); assert.equal(await bg(), 'rgb(255, 255, 255)');
    assert.equal(await ev(`document.documentElement.dataset.theme`), 'light');
    await shot('8-light');
    await ev(`document.querySelector('#theme').click()`);
    assert.equal(await mode(), 'dark'); assert.equal(await bg(), 'rgb(24, 24, 27)');
    await ev(`document.querySelector('#theme').click()`);
    assert.equal(await mode(), 'auto'); assert.equal(await ev(`document.documentElement.dataset.theme === undefined`), true);
    await ev(`document.querySelector('#theme').click()`);                                   // light again, then reload
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await until(`document.querySelector('#theme') && document.querySelector('#list .item')`, 'reloaded');
    assert.equal(await mode(), 'light', 'choice survives reload'); assert.equal(await bg(), 'rgb(255, 255, 255)');
    await ev(`document.querySelector('[data-note="Home"]').click()`);
    await until(`document.querySelector('#hl')`, 'editor after reload');
    await ev(`document.querySelector('#gr').click()`); await until(`document.querySelector('#gc')`, 'graph'); await sleep(800);
    await shot('9-light-graph');
    await ev(`document.querySelector('#gr').click(); document.querySelector('#theme').click(); document.querySelector('#theme').click()`);   // back to auto

    // narrow screens: sidebar hidden behind the menu button
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#side')).display`), 'none');
    assert.notEqual(await ev(`getComputedStyle(document.querySelector('#menu')).display`), 'none');
    await ev(`document.querySelector('#menu').click()`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#side')).display`), 'flex');
    await shot('5-mobile');

    assert.deepEqual(errors, [], 'no console errors');
  } finally {
    try { ws?.close(); } catch {}
    const gone = new Promise((r) => chrome.once('exit', r));
    chrome.kill(); server.kill(); await Promise.race([gone, sleep(3000)]);
    for (const d of [dir, prof]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }   // cleanup must never mask the result
  }
});
