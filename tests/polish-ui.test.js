// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Desktop polish: list order and previews, line spacing, empty states, creating from a search, and recovering from a failed load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { session, CHROME } = require('./helpers/session');

test('settings take effect and persist; empty states offer a way forward', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'Banana.md': '# Banana\nfirst note body text here', 'apple.md': 'second note with different words', 'Cherry.md': 'third' } });
  try {
    const { ev, until, typeInto } = s;
    const names = () => ev("[...document.querySelectorAll('#list .item[data-note]')].map((i) => i.dataset.note)");
    const t = Date.now() / 1000; fs.utimesSync(path.join(s.dir, 'Banana.md'), t - 300, t - 300); fs.utimesSync(path.join(s.dir, 'apple.md'), t - 200, t - 200); fs.utimesSync(path.join(s.dir, 'Cherry.md'), t - 100, t - 100); await ev('load()');
    assert.deepEqual(await names(), ['Cherry', 'apple', 'Banana'], 'newest first by default');
    // a line of text under each name
    assert.equal(await ev("document.querySelector('#list .item[data-note=\"Banana\"] .snip')?.textContent"), 'first note body text here');
    await ev("setSetting({ listPreview: false }); renderList()"); assert.equal(await ev("!!document.querySelector('#list .item .snip')"), false, 'previews can be turned off');
    // order by name (case-insensitive, so apple sorts before Banana)
    await ev("setSetting({ sort: 'name' }); renderList()"); assert.deepEqual(await names(), ['apple', 'Banana', 'Cherry']);
    await ev("pins.add('Cherry'); renderList()"); assert.deepEqual(await names(), ['Cherry', 'apple', 'Banana'], 'pinned notes still lead'); await ev("pins.delete('Cherry'); renderList()");
    // line spacing is applied as a variable the editor, its overlay and the reading view share
    await ev("setSetting({ lineHeight: 'relaxed' })"); assert.equal(await ev("getComputedStyle(document.documentElement).getPropertyValue('--lh').trim()"), '1.95');
    await ev("open('Banana', false)"); await until("!!document.querySelector('#ed')", 'editor'); assert.equal(await ev("getComputedStyle(document.querySelector('#ed')).lineHeight"), await ev("getComputedStyle(document.querySelector('#hl')).lineHeight"), 'overlay and textarea still line up');
    // the settings screen has the controls, and the choices are remembered across a reload
    await ev('openSettings()'); await until("!!document.querySelector('#st-sort')", 'settings'); await ev("(() => { const e = document.querySelector('#st-save'); e.value = '1500'; e.dispatchEvent(new Event('change', { bubbles: true })); })()");
    assert.equal(await ev('settings.autosave'), 1500); await ev("document.querySelector('#stx').click()");
    await s.reload(); assert.deepEqual(await ev('[settings.sort, settings.listPreview, settings.lineHeight, settings.autosave]'), ['name', false, 'relaxed', 1500]);
    await ev("setSetting({ sort: 'modified', listPreview: true, lineHeight: 'normal', autosave: 600 })");

    // an empty search offers to create the note; operators do not
    await typeInto('#q', 'Brand new idea'); await ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    assert.equal(await ev("document.querySelector('#createFromQuery')?.textContent"), 'Create “Brand new idea”');
    await ev("document.querySelector('#createFromQuery').click()"); await until("cur === 'Brand new idea' && notes.has('Brand new idea')", 'created'); assert.equal(await ev("document.querySelector('#q').value"), '');
    await typeInto('#q', 'tag:nothing'); await ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"); assert.equal(await ev("!!document.querySelector('#createFromQuery')"), false, 'not offered for search operators'); await typeInto('#q', '');
    // with nothing open, the pane offers real actions, and they work
    await ev('showEmpty()'); assert.equal(await ev("document.querySelector('#pane .empty-state h3').textContent"), 'Pick a note, or start one');
    assert.deepEqual(await ev("[...document.querySelectorAll('#pane .es-actions button')].map((b) => b.textContent)"), ['New note', 'Today’s note', 'Keyboard shortcuts']);
    await ev("[...document.querySelectorAll('#pane .es-actions button')].find((b) => b.textContent === 'Keyboard shortcuts').click()"); await until("!!document.querySelector('#shortcuts')", 'shortcuts'); await ev("PNUI && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await ev("showEmpty(); [...document.querySelectorAll('#pane .es-actions button')].find((b) => b.textContent === 'New note').click()"); await until("cur && /^Untitled/.test(cur)", 'new note from the empty state');

    // a failed load says so and offers a retry that works
    await ev("showLoadError(new Error('Failed to fetch'))"); assert.equal(await ev("document.querySelector('#list .empty-state h3').textContent"), 'Could not load your notes'); assert.match(await ev("document.querySelector('#list .empty-state p').textContent"), /not reachable.*files are untouched/);
    assert.equal(await ev("document.querySelectorAll('.toast.error').length"), 1);
    await ev("document.querySelector('#list .empty-state button').click()"); await until("document.querySelectorAll('#list .item[data-note]').length >= 3", 'list is back');
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
