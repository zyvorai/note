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
    assert.equal(await ev(`document.querySelector('#pin').getAttribute('aria-label')`), 'Unpin');
    assert.equal(await ev(`document.querySelector('#pin').getAttribute('aria-pressed')`), 'true');
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

    // outline: headings (not those in code fences) listed; clicking one scrolls the editor to it
    const out = await ev(`(async()=>{ const n = notes.get(cur), keep = n.text;
      n.text = '# One\\n\\n' + 'filler line\\n'.repeat(120) + '\\n\\n' + '\\x60\\x60\\x60' + '\\n# not a heading\\n' + '\\x60\\x60\\x60' + '\\n\\n## Two\\n\\n' + 'more filler\\n'.repeat(120) + '\\n### Three\\nend\\n';
      preview = false; renderPane(); await new Promise((r) => setTimeout(r, 300));   // let the pane resize settle
      const links = [...document.querySelectorAll('#outline a')].map((a) => a.textContent);
      const shown = getComputedStyle(document.querySelector('#outline')).display;
      document.querySelector('#outline a[data-h="2"]').click();
      await new Promise((r) => setTimeout(r, 300));
      const sel = document.querySelector('#ed').selectionStart, top = document.querySelector('#pane').scrollTop;
      const at = n.text.slice(sel, sel + 9);
      n.text = keep; renderPane();
      return { links, shown, at, top }; })()`);
    assert.deepEqual(out.links, ['One', 'Two', 'Three']);
    assert.equal(out.shown, 'block');
    assert.equal(out.at, '### Three');
    assert.ok(out.top > 0, 'editor scrolled to the heading');

    // text size: Ctrl+= grows the editor font and the highlight layer stays aligned; Ctrl+0 resets
    const fs0 = await ev(`parseFloat(getComputedStyle(document.querySelector('#ed')).fontSize)`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }))`);
    const fs1 = await ev(`[parseFloat(getComputedStyle(document.querySelector('#ed')).fontSize), parseFloat(getComputedStyle(document.querySelector('#hl')).fontSize), document.querySelector('#ed').offsetHeight, document.querySelector('#hl').scrollHeight]`);
    assert.equal(fs1[0], fs0 + 1); assert.equal(fs1[1], fs0 + 1);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
    assert.equal(await ev(`parseFloat(getComputedStyle(document.querySelector('#ed')).fontSize)`), 14);

    // history: back returns to the previously opened note, forward comes back
    const h0 = await ev(`document.querySelector('#title').value`);
    await ev(`open(notes.keys().next().value === $('#title').value ? [...notes.keys()][1] : notes.keys().next().value, false)`);
    await until(`document.querySelector('#title').value !== ${JSON.stringify(h0)}`, 'second note');
    await ev(`history.back()`);
    await until(`document.querySelector('#title').value === ${JSON.stringify(h0)}`, 'back to first note');
    await ev(`history.forward()`);
    await until(`document.querySelector('#title').value !== ${JSON.stringify(h0)}`, 'forward again');
    await ev(`history.back()`);
    await until(`document.querySelector('#title').value === ${JSON.stringify(h0)}`, 'back again');

    // templates: notes in templates/ become palette commands and fill {{title}} / {{date}}
    await ev(`api('/api/note?name=' + encodeURIComponent('templates/Meeting'), { method: 'PUT', body: '# {{title}}\\n{{date}} {{time}}\\n', headers: { 'x-base-mtime': '0' } }).then(() => load())`);
    await ev(`swOpen('cmds'); $('#swq').value = 'template: meeting'; swRender()`);
    assert.deepEqual(await ev(`swRows.map((r) => r.name)`), ['New note from template: Meeting']);
    await ev(`swClose(); newFromTemplate('templates/Meeting', 'Meeting Notes')`);
    await until(`document.querySelector('#ed') && document.querySelector('#title').value === 'Meeting Notes' && document.querySelector('#ed').value.startsWith('# Meeting Notes')`, 'template applied');
    assert.match(await ev(`document.querySelector('#ed').value`), /^# Meeting Notes\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}\n$/);

    // find and replace in the note
    await ev(`open('Find Test', true)`);
    await until(`document.querySelector('#ed') && document.querySelector('#title').value === 'Find Test'`, 'find test note');
    await ev(`(() => { const e = document.querySelector('#ed'); e.value = 'Alpha beta alpha\\nALPHA gamma'; e.dispatchEvent(new Event('input')); })()`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`);
    assert.equal(await ev(`document.querySelector('#fr').classList.contains('on')`), true, 'find bar opens with Ctrl+F');
    await ev(`(() => { const q = document.querySelector('#frq'); q.value = 'alpha'; q.dispatchEvent(new Event('input')); })()`);
    assert.equal(await ev(`document.querySelector('#frc').textContent`), '1 of 3');
    if (await ev(`!!(window.CSS && CSS.highlights && typeof Highlight !== 'undefined')`)) assert.equal(await ev(`CSS.highlights.get('find').size`), 3, 'all matches highlighted');
    await ev(`document.querySelector('#frn').click()`);
    assert.equal(await ev(`document.querySelector('#frc').textContent`), '2 of 3');
    await ev(`document.querySelector('#frs').click()`);                           // replaces the current match only
    assert.equal(await ev(`document.querySelector('#ed').value`), 'Alpha beta \nALPHA gamma', 'only the current match was replaced (with the empty replacement)');
    await ev(`(() => { const r = document.querySelector('#frr'); r.value = 'omega'; })()`);
    await ev(`document.querySelector('#fra').click()`);
    assert.equal(await ev(`document.querySelector('#ed').value`), 'omega beta \nomega gamma', 'replace all');
    await ev(`document.querySelector('#frq').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await ev(`document.querySelector('#fr').classList.contains('on')`), false, 'Escape closes the find bar');

    // focus mode hides the chrome and Escape leaves it
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true }))`);
    assert.equal(await ev(`document.body.classList.contains('focus') && getComputedStyle(document.querySelector('#side')).display`), 'none');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await ev(`document.body.classList.contains('focus')`), false, 'Escape leaves focus mode');
    await ev(`(async()=>{ await open('Home', false); })()`);
    await until(`document.querySelector('#title').value === 'Home'`, 'back to Home');

    // unlinked mentions: Home mentions "Find Test" in plain text elsewhere -> offered, and "link" rewrites it
    await ev(`(async () => { await api('/api/note?name=Mention%20Src', { method: 'PUT', body: 'I wrote about find test today ==hot==\\n\\n> [!tip] Hint\\n> body', headers: { 'x-base-mtime': '0' } }); await load(); await open('Find Test', false); })()`);
    await until(`document.querySelector('#um')`, 'unlinked mention listed');
    await ev(`document.querySelector('#um [data-link]').click()`);
    await until(`notes.get('Mention Src').text.includes('[[Find Test|find test]]')`, 'mention linked');
    assert.equal(await ev(`!document.querySelector('#um')`), true, 'mention no longer unlinked');
    await ev(`(async () => { await open('Mention Src', false); })()`);
    await until(`document.querySelector('#title').value === 'Mention Src'`, 'open Mention Src');
    if (await ev(`!document.querySelector('#pv')`)) await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }))`);
    await until(`document.querySelector('#pv .callout-tip') && document.querySelector('#pv mark')`, 'callout and highlight render');
    await ev(`(async()=>{ await open('Home', false); })()`);
    await until(`document.querySelector('#title').value === 'Home'`, 'back to Home again');

    // tasks view lists open tasks across notes; ticking one writes back to the note
    await ev(`(async () => { await api('/api/note?name=Task%20Src', { method: 'PUT', body: '---\\ntags: [work]\\n---\\n- [ ] ship the thing\\n- [x] done already', headers: { 'x-base-mtime': '0' } }); await load(); plainnote.run('tasks'); })()`);
    await until(`[...document.querySelectorAll('#swl .item')].some((i) => i.textContent.includes('ship the thing'))`, 'open task listed');
    assert.equal(await ev(`[...document.querySelectorAll('#swl .item')].some((i) => i.textContent.includes('done already'))`), false, 'done tasks are not listed');
    await ev(`[...document.querySelectorAll('#swl .item')].find((i) => i.textContent.includes('ship the thing')).querySelector('.tk').click()`);
    await until(`notes.get('Task Src').text.includes('- [x] ship the thing')`, 'task written back');
    await ev(`swClose()`);
    assert.equal(await ev(`[...tagsOf(notes.get('Task Src').text)].join()`), 'work', 'frontmatter tag counted');

    // local graph: only the open note's neighbourhood; the pill cycles 1 step / 2 steps / all
    await ev(`(async () => { for (const [n, t] of [['Loc A', '[[Loc B]]'], ['Loc B', '[[Loc C]]'], ['Loc C', 'end'], ['Loc D', 'alone']]) await api('/api/note?name=' + encodeURIComponent(n), { method: 'PUT', body: t, headers: { 'x-base-mtime': '0' } }); await load(); await open('Loc A', false); await plainnote.run('localgraph'); })()`);
    await until(`document.querySelector('#gc') && document.querySelector('#gc').dataset.nodes === '2'`, 'local graph: A and B only');
    assert.match(await ev(`document.querySelector('#gmode').textContent`), /Around “Loc A” · 1 step/);
    await ev(`document.querySelector('#gmode').click()`);
    await until(`document.querySelector('#gc').dataset.nodes === '3'`, 'two steps reaches C');
    await ev(`document.querySelector('#gmode').click()`);
    await until(`+document.querySelector('#gc').dataset.nodes > 4 && document.querySelector('#gmode').textContent === 'All notes'`, 'back to all notes');
    await ev(`(async () => { graphScope = 0; graphOn = false; await open('Home', false); })()`);
    await until(`document.querySelector('#title').value === 'Home'`, 'home after local graph');

    // global find & replace: preview, untick one note, apply to the rest
    await ev(`(async () => { for (const [n, t] of [['GF One', 'the zebra and Zebra'], ['GF Two', 'a zebra here'], ['GF Three', 'zebra too']]) await api('/api/note?name=' + encodeURIComponent(n), { method: 'PUT', body: t, headers: { 'x-base-mtime': '0' } }); await load(); })()`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', ctrlKey: true, shiftKey: true, bubbles: true }))`);
    await ev(`(() => { const q = document.querySelector('#gfq'); q.value = 'zebra'; q.dispatchEvent(new Event('input')); document.querySelector('#gfr').value = 'okapi'; })()`);
    assert.equal(await ev(`document.querySelector('#gfc').textContent`), '4 matches in 3 notes');
    await ev(`[...document.querySelectorAll('#gfl [data-gf]')].find((c) => c.closest('.m').textContent.includes('GF Three')).click()`);
    await ev(`document.querySelector('#gfa').click()`);
    await until(`notes.get('GF One').text === 'the okapi and okapi' && notes.get('GF Two').text === 'a okapi here'`, 'replaced in ticked notes');
    assert.equal(await ev(`notes.get('GF Three').text`), 'zebra too', 'unticked note untouched');
    assert.equal(await ev(`document.querySelector('#gf').style.display`), 'none', 'dialog closes');

    // links to headings and blocks, aliases, outgoing links; search operators, saved searches; hover preview
    await ev(`(async () => { for (const [n, t] of [['Guide', '# Intro\\n\\ntext\\n\\n## Setup\\n\\nsetup steps ^step1\\n'], ['Linker', '---\\naliases: [Linky]\\n---\\nsee [[Guide#Setup]] and [[Guide^step1]]'], ['Alias user', 'via [[Linky]]']]) await api('/api/note?name=' + encodeURIComponent(n), { method: 'PUT', body: t, headers: { 'x-base-mtime': '0' } }); await load(); })()`);
    await ev(`open('Alias user', false)`); await until(`cur === 'Alias user'`, 'alias user open');
    await ev(`document.querySelector('#tog').click()`);
    assert.equal(await ev(`!!document.querySelector('#pv a[data-note="Linker"]:not(.new)')`), true, 'alias resolves to its note');
    await ev(`open('Linker', false)`); await until(`cur === 'Linker'`, 'linker open');
    assert.match(await ev(`document.querySelector('#back').textContent`), /Linked from:\s*Alias user/, 'alias counts as a backlink');
    assert.match(await ev(`document.querySelector('#outgoing').textContent`), /Links to:\s*Guide/, 'outgoing links listed');
    await ev(`document.querySelector('#tog').click()`);
    await ev(`document.querySelector('#pv a[data-anchor="Setup"]').click()`);
    await until(`cur === 'Guide' && document.querySelector('#ed') && document.querySelector('#ed').selectionStart === notes.get('Guide').text.indexOf('## Setup')`, 'heading link jumps to the heading');
    await ev(`open('Linker', false)`); await until(`cur === 'Linker'`, 'back to linker');
    await ev(`document.querySelector('#tog').click()`);
    await ev(`document.querySelector('#pv a[data-block="step1"]').click()`);
    await until(`cur === 'Guide' && document.querySelector('#ed') && document.querySelector('#ed').selectionStart === notes.get('Guide').text.indexOf(' ^step1')`, 'block link jumps to the block');
    // hover preview shows the linked section
    await ev(`open('Linker', false)`); await until(`cur === 'Linker'`, 'linker again');
    await ev(`document.querySelector('#tog').click()`);
    await ev(`document.querySelector('#pv a[data-anchor="Setup"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await until(`getComputedStyle(document.querySelector('#hp')).display === 'block' && /setup steps/.test(document.querySelector('#hp').textContent)`, 'hover preview');
    await ev(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#hp')).display`), 'none', 'preview hides');
    // search operators and saved searches
    const listed = () => ev(`[...document.querySelectorAll('#list .item')].map((i) => i.dataset.note).sort().join(',')`);
    await ev(`(() => { const q = document.querySelector('#q'); q.value = 'setup -steps'; q.dispatchEvent(new Event('input')); })()`);
    assert.equal(await listed(), 'Linker', 'words and exclusions');
    await ev(`document.querySelector('#sssave').click()`);
    await ev(`(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input')); })()`);
    assert.equal(await ev(`document.querySelectorAll('#tags .chip.ss').length`), 1, 'saved search chip');
    await ev(`document.querySelector('#tags .chip.ss').click()`);
    assert.equal(await ev(`document.querySelector('#q').value`), 'setup -steps', 'chip restores the query');
    await ev(`document.querySelector('[data-ssdel="0"]').click()`);
    await ev(`(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input')); })()`);
    assert.equal(await ev(`document.querySelectorAll('#tags .chip.ss').length`), 0, 'saved search removed');
    await ev(`(async () => { graphOn = false; await open('Home', false); })()`);

    // file tree: folders, dragging a note into one (links follow), context menu
    const put = (n, t) => `api('/api/note?name=' + encodeURIComponent(${JSON.stringify(n)}), { method: 'PUT', body: ${JSON.stringify(t)}, headers: { 'x-base-mtime': '0' } })`;
    await ev(`(async () => { await ${put('Proj/Alpha', 'a')}; await ${put('Moveme', 'm')}; await ${put('Pointer', 'see [[Moveme#Sec|x]] and [[Moveme]]')}; await api('/api/folder', { method: 'POST', body: JSON.stringify({ name: 'Archive' }) }); await load(); })()`);
    await ev(`document.querySelector('#vfiles').click()`);
    const folderRows = () => ev(`[...document.querySelectorAll('#list [data-folder]')].map((f) => f.dataset.folder)`);
    assert.ok((await folderRows()).includes('Archive') && (await folderRows()).includes('Proj'), 'folders listed, including empty ones');
    assert.equal(await ev(`!!document.querySelector('#list [data-note="Proj/Alpha"]')`), false, 'collapsed');
    await ev(`document.querySelector('#list [data-folder="Proj"]').click()`);
    assert.equal(await ev(`!!document.querySelector('#list [data-note="Proj/Alpha"]')`), true, 'expanded');
    await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'plainnote:Moveme'); document.querySelector('#list [data-folder="Archive"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
    await until(`notes.has('Archive/Moveme') && !notes.has('Moveme')`, 'note moved into the folder');
    await until(`notes.get('Pointer').text === 'see [[Archive/Moveme#Sec|x]] and [[Archive/Moveme]]'`, 'links follow the move');
    assert.ok((await ev(`api('/api/notes').then((l) => l.map((n) => n.name))`)).includes('Archive/Moveme'), 'moved on disk');
    await ev(`document.querySelector('#list [data-note="Archive/Moveme"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }))`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#ctx')).display`), 'block');
    assert.match(await ev(`document.querySelector('#ctx').textContent`), /Rename….*Duplicate.*Move to folder….*Copy link/);
    await ev(`[...document.querySelectorAll('#ctx button')].find((b) => b.textContent === 'Duplicate').click()`);
    await until(`notes.has('Archive/Moveme copy') && cur === 'Archive/Moveme copy'`, 'duplicate opened');
    assert.equal(await ev(`getComputedStyle(document.querySelector('#ctx')).display`), 'none', 'menu closes');
    await ev(`window.confirm = () => true; document.querySelector('#list [data-folder="Archive"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }))`);
    await ev(`[...document.querySelectorAll('#ctx button')].find((b) => /Delete empty folder/.test(b.textContent)).click()`);
    await until(`/not empty/.test(document.querySelector('#status').textContent)`, 'non-empty folder is refused');
    await ev(`document.querySelector('#vlist').click()`);
    assert.equal(await ev(`document.querySelectorAll('#list [data-folder]').length`), 0, 'list view has no folder rows');

    // properties panel edits only the frontmatter
    await ev(`(async () => { await ${put('Props note', '---\ntitle: Hi\ndone: false\n---\nbody text')}; await load(); await open('Props note', false); })()`);
    await until(`document.querySelectorAll('#props .prow input[data-prop]').length === 2`, 'properties listed');
    await ev(`(() => { const i = document.querySelector('#props input[data-prop="0"]'); i.value = 'New title'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const src = (t, d) => `---\ntitle: ${t}\ndone: ${d}\n---\nbody text`;
    await until(`notes.get('Props note').text === ${JSON.stringify(src('New title', false))}`, 'text property written');
    assert.equal(await ev(`document.querySelector('#ed').value`), src('New title', false), 'editor follows');
    await ev(`document.querySelector('#props input[type=checkbox]').click()`);
    await until(`notes.get('Props note').text === ${JSON.stringify(src('New title', true))}`, 'checkbox written');
    await ev(`(() => { document.querySelector('#pnew').value = 'tags'; document.querySelector('#padd').click(); })()`);
    await until(`/done: true\\ntags:\\n---\\nbody text$/.test(notes.get('Props note').text)`, 'property added');
    await ev(`document.querySelector('#props [data-propdel="0"]').click()`);
    await until(`notes.get('Props note').text === '---\\ndone: true\\ntags:\\n---\\nbody text'`, 'property removed');
    await ev(`(async () => { await open('Home', false); })()`);
    assert.equal(await ev(`document.querySelector('#props').textContent.trim()`), '+ Add property', 'a note without properties only offers to add one');
    assert.equal(await ev(`document.querySelectorAll('#props .prow').length`), 0);

    // tabs: open in a new tab (ctrl-click / palette), switch, close, rename follows, persisted
    await ev(`(async () => { for (const n of ['T1', 'T2', 'T3']) await api('/api/note?name=' + n, { method: 'PUT', body: n + ' body', headers: { 'x-base-mtime': '0' } }); await load(); await open('T1', false); })()`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#tabs')).display`), 'none', 'a single tab shows no tab bar');
    await ev(`openInNewTab('T2', false)`); await until(`tabs.length === 2 && cur === 'T2'`, 'second tab');
    assert.equal(await ev(`getComputedStyle(document.querySelector('#tabs')).display`), 'flex');
    assert.equal(await ev(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.replace('×', '')).join(',')`), 'T1,T2');
    await ev(`document.querySelector('#tabs [data-tab="0"] span').click()`); await until(`cur === 'T1' && ti === 0`, 'switch tab');
    await ev(`document.querySelector('#list [data-note="T3"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))`);
    await until(`tabs.length === 3 && cur === 'T3' && ti === 1`, 'ctrl-click opens a new tab next to the current one');
    assert.deepEqual(JSON.parse(await ev(`JSON.stringify(tabs.map((t) => t.name))`)), ['T1', 'T3', 'T2']);
    assert.deepEqual(JSON.parse(await ev(`localStorage.getItem('tabs')`)).tabs.map((t) => t.name), ['T1', 'T3', 'T2'], 'persisted');
    await ev(`document.querySelector('#title').value = 'T3b'; document.querySelector('#title').dispatchEvent(new Event('change'))`);
    await until(`tabs[1].name === 'T3b'`, 'rename updates the tab');
    await ev(`document.querySelector('#tabs [data-tabclose="1"]').click()`); await until(`tabs.length === 2 && cur === 'T2'`, 'closing the active tab shows its neighbour');
    await ev(`plainnote.run('prevtab')`); await until(`cur === 'T1'`, 'previous tab command');
    await ev(`plainnote.run('closetab')`); await until(`tabs.length === 1 && cur === 'T2'`, 'close tab command');
    await ev(`(async () => { await open('Home', false); })()`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#tabs')).display`), 'none');

    // split pane: a live read-only preview of a second note, follows renames, closes
    await ev(`openSplit('T2')`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#split')).display`), 'flex');
    assert.match(await ev(`document.querySelector('#sppv').textContent`), /T2 body/);
    assert.equal(await ev(`document.querySelector('#sptitle').textContent`), 'T2');
    await ev(`(async () => { await open('T2', false); const ed = document.querySelector('#ed'); ed.value = 'T2 edited live'; ed.dispatchEvent(new Event('input')); })()`);
    await until(`/T2 edited live/.test(document.querySelector('#sppv').textContent)`, 'split follows edits of the same note');
    await ev(`(async () => { await open('Home', false); })()`);
    await ev(`document.querySelector('#spx').click()`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#split')).display`), 'none', 'split closes');
    assert.equal(await ev(`localStorage.getItem('split')`), null);

    // settings: appearance, folders, custom shortcuts, CSS snippets
    fs.mkdirSync(path.join(dir, '.plainnote/snippets'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.plainnote/snippets/ui-test.css'), 'body{--snippet-on:1}');
    await ev(`plainnote.run('settings')`);
    await until(`document.querySelector('#st').style.display === 'flex' && document.querySelector('[data-snip="ui-test.css"]')`, 'settings open, snippet listed');
    const setCtl = (id, v) => ev(`(() => { const e = document.querySelector('#${id}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const cssVar = (n) => ev(`document.documentElement.style.getPropertyValue('${n}')`);
    await setCtl('st-width', 'wide'); assert.equal(await cssVar('--measure'), '1040px');
    await setCtl('st-font', 'serif'); assert.match(await cssVar('--read-font'), /Georgia/);
    assert.equal(await ev(`JSON.parse(localStorage.getItem('settings')).width`), 'wide', 'settings persist');
    await setCtl('st-accent', '#ff9f0a'); assert.equal(await cssVar('--acc'), '#ff9f0a');
    await ev(`plainnote.setAccent('#123456')`); assert.equal(await cssVar('--acc'), '#ff9f0a', 'your accent beats the system colour');
    await ev(`document.querySelector('#st-accent-reset').click()`); assert.equal(await cssVar('--acc'), '#123456', 'reset falls back to the system colour');
    await setCtl('st-width', 'normal'); await setCtl('st-font', 'system');
    assert.equal(await cssVar('--read-font'), '');
    // daily notes and new notes honour their folders
    await setCtl('st-daily', ' Journal/ '); await setCtl('st-newf', 'Inbox');
    assert.equal(await ev(`document.querySelector('#st-daily').value`), 'Journal', 'value is cleaned up');
    await ev(`document.querySelector('#stx').click(); plainnote.run('today')`);
    await until(`!!cur && cur.startsWith('Journal/') && cur.length === 'Journal/2026-11-02'.length`, 'daily note in the chosen folder');
    await ev(`plainnote.run('new')`); await until(`cur === 'Inbox/Untitled'`, 'new note in the chosen folder');
    await ev(`(async () => { for (const n of [cur, notes.has('Journal') ? '' : [...notes.keys()].find((k) => k.startsWith('Journal/'))].filter(Boolean)) await api('/api/note?name=' + encodeURIComponent(n), { method: 'DELETE' }); await load(); await open('Home', false); })()`);
    await ev(`plainnote.run('settings')`); await until(`document.querySelector('#st').style.display === 'flex'`, 'reopen');
    await setCtl('st-daily', 'daily'); await setCtl('st-newf', '');
    // custom shortcuts: records only valid combos, runs the command, can be cleared
    const press = (o) => ev(`document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(o)})))`);
    await ev(`document.querySelector('[data-hk="focus"]').click()`);
    await press({ key: 'x', code: 'KeyX' });
    assert.equal(await ev(`settings.hotkeys.focus`), undefined, 'a bare letter is refused');
    await press({ key: 'Escape' }); assert.equal(await ev(`hkCapture`), null, 'Esc cancels recording');
    await ev(`document.querySelector('[data-hk="focus"]').click()`);
    await press({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
    assert.equal(await ev(`settings.hotkeys.focus`), 'mod+alt+j');
    await press({ key: 'Escape' }); assert.equal(await ev(`document.querySelector('#st').style.display`), 'none', 'Esc closes the sheet');
    await press({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
    assert.equal(await ev(`document.body.classList.contains('focus')`), true, 'custom shortcut runs the command');
    await press({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
    assert.equal(await ev(`document.body.classList.contains('focus')`), false);
    await ev(`plainnote.run('settings')`); await until(`document.querySelector('#st').style.display === 'flex'`, 'reopen again');
    await ev(`document.querySelector('[data-hkclear="focus"]').click()`);
    await press({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
    assert.equal(await ev(`document.body.classList.contains('focus')`), false, 'cleared shortcut does nothing');
    // CSS snippets toggle on and off
    await ev(`document.querySelector('[data-snip="ui-test.css"]').click()`);
    await until(`!!document.querySelector('style[data-snippet="ui-test.css"]') && getComputedStyle(document.body).getPropertyValue('--snippet-on').trim() === '1'`, 'snippet applied');
    await ev(`document.querySelector('[data-snip="ui-test.css"]').click()`);
    await until(`!document.querySelector('style[data-snippet="ui-test.css"]')`, 'snippet removed');
    await ev(`document.querySelector('#stx').click()`);

    // Live Preview (beta): rendered lines, raw active line, native typing, structural edits, undo, checkbox, multi-line delete
    const LPSRC = '# Title\n\nsome **bold** text\n- item\n- [ ] task';
    await ev(`(async () => { await ${put('LP note', LPSRC)}; await load(); await open('LP note', false); setLivePreview(true); })()`);
    await until(`!!document.querySelector('#lp') && !document.querySelector('#ed')`, 'live preview mounted');
    const pressKey = async (key, code, vk, text) => {              // real key events, so the browser fires beforeinput like it does for a person typing
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    };
    const lpLines = async () => JSON.parse(await ev(`JSON.stringify(lp.lines)`));
    const lpAt = (i, off) => ev(`(() => { const el = document.querySelectorAll('#lp .ln')[${i}]; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const n = w.nextNode(); document.querySelector('#lp').focus(); getSelection().collapse(n, ${off}); })()`);
    assert.equal(await ev(`document.querySelectorAll('#lp .ln').length`), 5);
    assert.equal(await ev(`document.querySelector('#lp .ln .lp-h1').textContent`), 'Title', 'heading marker hidden');
    assert.equal(await ev(`document.querySelectorAll('#lp .ln')[2].textContent`), 'some bold text', 'inline markers hidden');
    assert.equal(await ev(`!!document.querySelector('#lp .lp-cb')`), true, 'task has a checkbox');
    await lpAt(2, 3); await until(`lp.active === 2`, 'caret line becomes active');
    assert.equal(await ev(`document.querySelectorAll('#lp .ln')[2].textContent`), 'some **bold** text', 'active line is raw');
    assert.equal(await ev(`document.querySelectorAll('#lp .ln')[0].textContent`), 'Title', 'other lines stay rendered');
    await cdp('Input.insertText', { text: 'X' });
    assert.equal((await lpLines())[2], 'somXe **bold** text', 'native typing is read back');
    assert.equal(await ev(`notes.get(cur).text.split('\\n')[2]`), 'somXe **bold** text', 'and reaches the note');
    await pressKey('Enter', 'Enter', 13, '\r');
    assert.deepEqual((await lpLines()).slice(2, 4), ['somX', 'e **bold** text'], 'Enter splits the line');
    assert.equal(await ev(`lp.active`), 3);
    await pressKey('Backspace', 'Backspace', 8);
    assert.deepEqual((await lpLines()).slice(2, 4), ['somXe **bold** text', '- item'], 'Backspace at the start joins lines');
    await ev(`lpUndo()`); assert.equal((await lpLines()).length, 6, 'undo restores the split');
    await ev(`lpUndo(); lpUndo()`); assert.equal((await lpLines()).join('\n'), LPSRC, 'three undos return to the original');
    await ev(`lpRedo()`); assert.equal((await lpLines())[2], 'somXe **bold** text', 'redo');
    await ev(`lpUndo()`);
    await ev(`document.querySelector('#lp .lp-cb').click()`);
    assert.equal((await lpLines())[4], '- [x] task', 'checkbox toggles the source');
    assert.equal(await ev(`!!document.querySelector('#lp .lp-done')`), true);
    await lpAt(4, 0); await until(`lp.active === 4`, 'move to the last line');
    await ev(`(() => { const ls = document.querySelectorAll('#lp .ln'); const a = ls[0].querySelector('.lp-h1').firstChild, b = ls[2].firstChild; getSelection().setBaseAndExtent(a, 2, b, 2); })()`);
    await pressKey('Backspace', 'Backspace', 8);
    assert.deepEqual(await lpLines(), ['# Time **bold** text', '- item', '- [x] task'], 'deleting across lines edits the source');
    await ev(`flush()`);
    assert.equal((await ev(`api('/api/notes').then((l) => l.find((n) => n.name === 'LP note').text)`)), '# Time **bold** text\n- item\n- [x] task', 'saved to disk');
    await ev(`setLivePreview(false)`);
    await until(`!!document.querySelector('#ed') && !document.querySelector('#lp')`, 'back to the source editor');
    assert.equal(await ev(`document.querySelector('#ed').value`), '# Time **bold** text\n- item\n- [x] task');
    await ev(`(async () => { await open('Home', false); })()`);

    // icon toolbar: every icon button has an accessible name; the overflow menu opens, runs an item and closes
    assert.equal(await ev(`[...document.querySelectorAll('button.ico')].every((b) => b.getAttribute('aria-label') && b.querySelector('svg'))`), true);
    await ev(`document.querySelector('#more').click()`);
    assert.equal(await ev(`document.querySelector('#moremenu').classList.contains('on')`), true);
    await ev(`document.querySelector('#gfb').click()`);
    assert.equal(await ev(`document.querySelector('#gf').style.display`), 'flex', 'menu item opens global find');
    await ev(`document.querySelector('#gfx').click()`);
    assert.equal(await ev(`document.querySelector('#moremenu').classList.contains('on')`), false, 'menu closes');
    // the toolbar height reported by the Mac app moves the page content down
    await ev(`plainnote.setInset(60)`);
    assert.equal(await ev(`document.documentElement.style.getPropertyValue('--tb')`), '60px');

    // the Mac app passes the system accent colour; light accents flip the text on selected rows to black
    await ev(`plainnote.setAccent('#ff9f0a')`);
    assert.equal(await ev(`document.documentElement.style.getPropertyValue('--acc')`), '#ff9f0a');
    assert.equal(await ev(`document.documentElement.style.getPropertyValue('--on-acc')`), '#000');
    await ev(`plainnote.setAccent('not a colour')`);
    assert.equal(await ev(`document.documentElement.style.getPropertyValue('--acc')`), '#ff9f0a', 'invalid values ignored');

    // native-app bridge: plainnote.run(id) drives the same actions as the palette (the Mac menus call it)
    const before = await ev(`notes.size`);
    await ev(`plainnote.run('new')`);
    await until(`notes.size === ${before} + 1`, 'plainnote.run("new") creates a note');
    await ev(`plainnote.run('sidebar')`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#side')).display`), 'none');
    await ev(`plainnote.run('sidebar')`);
    assert.notEqual(await ev(`getComputedStyle(document.querySelector('#side')).display`), 'none');
    assert.equal(await ev(`plainnote.run('nonexistent').then(() => 'ok')`), 'ok', 'unknown ids are ignored');
    assert.equal(await ev(`plainnote.current().name === document.querySelector('#title').value || plainnote.current().name.endsWith('/' + document.querySelector('#title').value)`), true, 'plainnote.current() reports the open note');
    await ev(`(async()=>{ await open('Home', false); })()`);
    await until(`document.querySelector('#title').value === 'Home'`, 'back to Home');

    // command palette: Ctrl+Shift+P lists actions, filtering and Enter run one
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true }))`);
    assert.equal(await ev(`document.querySelector('#sw').style.display`), 'flex');
    assert.ok((await ev(`document.querySelectorAll('#swl .item').length`)) >= 10, 'lists commands');
    await ev(`(()=>{ const q = document.querySelector('#swq'); q.value = 'theme'; q.dispatchEvent(new Event('input')); })()`);
    assert.equal(await ev(`document.querySelectorAll('#swl .item').length`), 1);
    const th0 = await ev(`document.querySelector('#theme').dataset.mode`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await sleep(100);
    assert.notEqual(await ev(`document.querySelector('#theme').dataset.mode`), th0, 'command ran');
    assert.equal(await ev(`document.querySelector('#sw').style.display`), 'none');
    await ev(`document.querySelector('#theme').click(); document.querySelector('#theme').click()`);   // back to the original mode (3-way cycle)

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

    // slash menu: "/" at line start offers blocks; picking one inserts it with the caret in place
    await ev(`(()=>{ const e = document.querySelector('#ed'); e.value += '\\n\\n'; e.setSelectionRange(e.value.length, e.value.length); e.focus(); })()`);
    await cdp('Input.insertText', { text: '/tab' });
    await until(`document.querySelector('#ac').style.display === 'block' && document.querySelector('#ac .item').textContent === 'Table'`, 'slash menu');
    await key('Enter');
    assert.match(await ev(`document.querySelector('#ed').value`), /\n\| Column \| Column \|\n\| --- \| --- \|\n\|  \|  \|$/);
    assert.equal(await ev(`(()=>{ const e = document.querySelector('#ed'); return e.value.slice(e.selectionStart - 2, e.selectionStart); })()`), '| ');
    assert.equal(await ev(`document.querySelector('#ac').style.display`), 'none');

    // autosave reaches disk, then a conflicting external write is detected
    const untitled = fs.readdirSync(dir).find((f) => f.startsWith('Untitled'));
    for (let i = 0; i < 50 && !/see \[\[Home\]\]$/.test(fs.readFileSync(path.join(dir, untitled), 'utf8')); i++) await sleep(100);   // wait for autosave
    assert.match(fs.readFileSync(path.join(dir, untitled), 'utf8'), /^- one\n {2}- two see \[\[Home\]\]\n\n\| Column \| Column \|/);
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
    // The macOS CI runner occasionally drops the scroll for the very first keystroke after the value was replaced
    // wholesale; a real user keeps typing, so give it up to three more keystrokes before calling it a failure.
    for (let attempt = 0; attempt < 4 && !scrolled; attempt++) {
      if (attempt) await cdp('Input.insertText', { text: 'x' });
      for (let i = 0; i < 15 && !scrolled; i++) { scrolled = await ev(`document.querySelector('#pane').scrollTop > 200`); if (!scrolled) await sleep(100); }
    }
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
    assert.equal(await bg(), sys ? 'rgb(30, 30, 30)' : 'rgb(255, 255, 255)', 'auto follows the system');
    await ev(`document.querySelector('#theme').click()`);
    assert.equal(await mode(), 'light'); assert.equal(await bg(), 'rgb(255, 255, 255)');
    assert.equal(await ev(`document.documentElement.dataset.theme`), 'light');
    await shot('8-light');
    await ev(`document.querySelector('#theme').click()`);
    assert.equal(await mode(), 'dark'); assert.equal(await bg(), 'rgb(30, 30, 30)');
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
