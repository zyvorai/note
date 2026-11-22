// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// The reading view: nested lists, ticking tasks in place, links to sections, code copy buttons, footnote jumps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

test('reading view: tick tasks (nested, below frontmatter), copy section links and code, footnotes keep the address', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const doc = '---\ntags: demo\n---\n# Plan\n\n- [ ] first\n  - [ ] nested child\n  - [x] done child\n- plain item\n\n## Details & Notes\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\nA claim[^1] to check.\n\n[^1]: The source.\n';
  const s = await session({ files: { 'Doc.md': doc } });
  try {
    const { ev, until, cdp } = s;
    await cdp('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: s.base }); await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await ev("open('Doc', false)"); await until("cur === 'Doc'", 'open'); await ev("preview = true; renderPane()"); await until("!!document.querySelector('#pv h1')", 'preview');
    // nested lists render as nested lists
    assert.equal(await ev("document.querySelectorAll('#pv li > ul').length"), 1); assert.equal(await ev("document.querySelectorAll('#pv li > ul > li').length"), 2);
    // tick a top-level task, then a nested one: the right lines change on disk, and unticking works
    const boxes = () => ev("[...document.querySelectorAll('#pv input[type=checkbox]')].map((c) => c.checked)");
    assert.deepEqual(await boxes(), [false, false, true]);
    await ev("document.querySelectorAll('#pv input[type=checkbox]')[0].click()"); await until("!dirty", 'saved'); assert.match(s.read('Doc.md'), /\n- \[x\] first\n  - \[ \] nested child\n  - \[x\] done child\n/);
    assert.deepEqual(await boxes(), [true, false, true], 'the preview shows the new state');
    await ev("document.querySelectorAll('#pv input[type=checkbox]')[1].click()"); await until("!dirty", 'saved 2'); assert.match(s.read('Doc.md'), /\n  - \[x\] nested child\n/);
    await ev("document.querySelectorAll('#pv input[type=checkbox]')[2].click()"); await until("!dirty", 'saved 3'); assert.match(s.read('Doc.md'), /\n  - \[ \] done child\n/);
    assert.ok(s.read('Doc.md').startsWith('---\ntags: demo\n---\n# Plan'), 'the frontmatter is untouched');

    // headings can be linked to: the button copies a [[Note#Heading]] link
    assert.equal(await ev("document.querySelector('#pv h2').id"), 'details-notes');
    await ev("document.querySelector('#pv h2 .hlink').click()"); await until("!!document.querySelector('.toast')", 'toast');
    assert.equal(await ev("navigator.clipboard.readText()"), '[[Doc#Details & Notes]]');
    // code blocks have a copy button that copies the code, not its own label
    await ev("document.querySelector('#pv pre .cpy').click()"); assert.equal(await ev("navigator.clipboard.readText()"), 'const a = 1;\nconsole.log(a);');
    assert.equal(await ev("document.querySelector('#pv pre code').textContent.includes('Copy')"), false);
    // a footnote link scrolls to the footnote without changing the address (which holds the open note's name)
    const hash = await ev('location.hash'); await ev("document.querySelector('#pv sup.fn a').click()"); await s.sleep(200);
    assert.equal(await ev('location.hash'), hash, 'the address still names the open note'); assert.equal(await ev('cur'), 'Doc'); assert.equal(await ev("document.getElementById('fn-1').classList.contains('flash')"), true);
    // the buttons are added by the app: the rendered HTML itself (used by export and publish) has none
    assert.doesNotMatch(await ev("md(notes.get('Doc').text)"), /hlink|cpy/);
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
