// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../public/ui.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));

test('fuzzy: substring beats scattered, word starts and runs score higher, no match is null', () => {
  const f = (q, t) => U.fuzzy(q, t);
  assert.equal(f('zzz', 'Toggle graph view'), null); assert.equal(f('gx', 'graph'), null);
  assert.deepEqual(f('', 'anything'), { score: 0, idx: [] });
  assert.deepEqual(f('TG', 'Toggle graph view').idx, [0, 7]);                       // case-insensitive, word starts
  assert.ok(f('graph', 'Toggle graph view').score > f('tgv', 'Toggle graph view').score);          // exact substring wins
  assert.ok(f('ex', 'Export this note as PDF').score > f('ex', 'Text file').score);                 // start of string/word beats the middle of a word
  assert.ok(f('exp', 'Export').score > f('exp', 'e-x-p').score);                                    // contiguous beats scattered even at word starts
  assert.ok(f('pdf', 'Export this note as PDF').score > f('pdf', 'Printing documents for friends').score);   // a run beats scattered letters
  assert.deepEqual(f('a b', 'alpha beta').idx.length, 2);                            // spaces in the query are ignored for scattering
  assert.ok(f('note', 'Notes').score > f('note', 'Daily notes folder for all my notes').score);       // shorter, tighter target ranks first
});

test('highlight escapes text and wraps matched characters', () => {
  assert.equal(U.highlight('a<b>c', [1]), 'a<mark>&lt;</mark>b&gt;c');
  assert.equal(U.highlight('hello', [0, 1, 4]), '<mark>he</mark>ll<mark>o</mark>');
  assert.equal(U.highlight('x"y', []), 'x&quot;y');
});

test('dialogs, toasts and prompts behave in a real browser', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-ui-kit-')), page = path.join(dir, 't.html'), pub = path.join(__dirname, '..', 'public');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${pub}/app.css"><div id="app"><button id="opener">opener</button><input id="bg"></div><nav id="tabbar"></nav>
<script src="file://${pub}/ui.js"></script><pre id="o">pending</pre><script>
const out = []; const log = (k, v) => out.push([k, v]);
const tab = (shift) => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true }));
const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
(async () => {
  const opener = document.getElementById('opener'); opener.focus();
  // 1. dialog: roles, labelling, inert background, focus into the dialog, Tab wraps both ways, Esc closes and returns focus
  let closedWith = 'unset';
  const d = PNUI.openDialog({ title: 'Hello', body: '<input id="a"><input id="b">', actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: (c) => c('ok') }], onClose: (r) => { closedWith = r; } });
  const box = d.box; log('role', box.getAttribute('role') + '/' + box.getAttribute('aria-modal'));
  log('labelled', document.getElementById(box.getAttribute('aria-labelledby')).textContent);
  log('inert', document.getElementById('app').hasAttribute('inert') && document.getElementById('tabbar').hasAttribute('inert'));
  log('focus-in', box.contains(document.activeElement) && document.activeElement.id);
  const btns = box.querySelectorAll('footer button'); btns[1].focus(); tab(false); log('wrap-forward', box.contains(document.activeElement) && document.activeElement.className === 'dlg-x');
  tab(true); log('wrap-back', document.activeElement === btns[1]);
  document.getElementById('bg').focus(); tab(false); log('focus-pulled-back', box.contains(document.activeElement));
  esc(); await d.closed; log('esc-closes', !document.querySelector('.dlg') && closedWith === null); log('focus-returned', document.activeElement === opener); log('inert-removed', !document.getElementById('app').hasAttribute('inert'));
  // 2. backdrop: a drag that ends on the backdrop does not close; a real click does
  const d2 = PNUI.openDialog({ title: 'B', body: 'x' }); const scrim = document.querySelector('.dlg-scrim');
  document.querySelector('.dlg').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  log('drag-ends-on-backdrop', !!document.querySelector('.dlg'));
  scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); scrim.dispatchEvent(new MouseEvent('click', { bubbles: true })); await d2.closed; log('click-backdrop-closes', !document.querySelector('.dlg'));
  // 3. canClose can veto (a busy operation)
  let busy = true; const d3 = PNUI.openDialog({ title: 'C', body: 'x', canClose: () => !busy }); esc(); log('vetoed', !!document.querySelector('.dlg')); busy = false; esc(); await d3.closed; log('allowed-after', !document.querySelector('.dlg'));
  // 4. stacked dialogs: Esc closes only the top one; the background stays inert until the last closes
  const s1 = PNUI.openDialog({ title: '1', body: 'x' }), s2 = PNUI.openDialog({ title: '2', body: 'x' }); esc(); await s2.closed;
  log('stack-top-only', document.querySelectorAll('.dlg').length === 1 && document.getElementById('app').hasAttribute('inert')); esc(); await s1.closed; log('stack-done', !document.getElementById('app').hasAttribute('inert'));
  // 5. askText validates inline and resolves with the value; Cancel resolves null
  const p = PNUI.askText({ title: 'Name', value: 'x', validate: (v) => (v.includes('/') ? 'No slashes' : '') });
  const inp = document.querySelector('.dlg input'); inp.value = 'a/b'; document.querySelector('.dlg form').requestSubmit(); log('validation', document.querySelector('.dlg-err').textContent + '|' + !!document.querySelector('.dlg'));
  inp.value = 'fine'; document.querySelector('.dlg form').requestSubmit(); log('ask-text', await p);
  const p2 = PNUI.askText({ title: 'Name' }); esc(); log('ask-cancel', await p2);
  const c1 = PNUI.askConfirm({ title: 'Sure?', message: 'Really?', ok: 'Delete', danger: true }); log('confirm-focus', document.activeElement.textContent); document.activeElement.click(); log('confirm-yes', await c1);
  const c2 = PNUI.askConfirm({ title: 'Sure?', message: 'Really?' }); esc(); log('confirm-esc', await c2);
  // 6. toasts: live region, action runs once and closes, errors are sticky with a dismiss button, at most 4
  let undone = 0; const t1 = PNUI.toast('Deleted', { action: { label: 'Undo', run: () => undone++ } });
  log('live-region', document.getElementById('toasts').getAttribute('aria-live')); t1.el.querySelector('button').click(); log('undo-once', undone === 1 && !t1.el.isConnected);
  const e = PNUI.toast('Failed', { kind: 'error' }); log('error-sticky', !!e.el.querySelector('.toast-x') && e.el.classList.contains('error'));
  for (let i = 0; i < 6; i++) PNUI.toast('n' + i, { ms: 0 }); log('max-4', document.querySelectorAll('.toast').length === 4);
  // 7. empty state
  const host = document.createElement('div'); document.body.appendChild(host); let ran = 0; PNUI.emptyState(host, { title: 'Nothing', body: 'Try more', actions: [{ label: 'Go', primary: true, run: () => ran++ }] }); host.querySelector('button').click(); log('empty', host.querySelector('h3').textContent + '/' + ran);
  document.getElementById('o').textContent = JSON.stringify(out);
})().catch((e) => { document.getElementById('o').textContent = 'ERR ' + e.stack; });</script>`);
  const html = execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', `--user-data-dir=${path.join(dir, 'p')}`, '--virtual-time-budget=5000', '--dump-dom', 'file://' + page], { encoding: 'utf8', timeout: 60000 });
  const raw = html.match(/<pre id="o">([\s\S]*?)<\/pre>/)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.ok(!raw.startsWith('ERR'), raw);
  const r = Object.fromEntries(JSON.parse(raw));
  assert.deepEqual(r, { role: 'dialog/true', labelled: 'Hello', inert: true, 'focus-in': 'a', 'wrap-forward': true, 'wrap-back': true, 'focus-pulled-back': true, 'esc-closes': true, 'focus-returned': true, 'inert-removed': true,
    'drag-ends-on-backdrop': true, 'click-backdrop-closes': true, vetoed: true, 'allowed-after': true, 'stack-top-only': true, 'stack-done': true,
    validation: 'No slashes|true', 'ask-text': 'fine', 'ask-cancel': null, 'confirm-focus': 'Delete', 'confirm-yes': true, 'confirm-esc': false,
    'live-region': 'polite', 'undo-once': true, 'error-sticky': true, 'max-4': true, empty: 'Nothing/1' });
});
