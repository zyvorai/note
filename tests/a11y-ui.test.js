// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Keyboard and screen-reader behaviour of the real app: roles, roving focus, labelled controls, the palette combobox, the phone drawer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

const NAMELESS = `(() => {
  const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[inert],[hidden]');
  const nameOf = (e) => (e.getAttribute('aria-label') || '').trim() || (e.getAttribute('aria-labelledby') && [...e.getAttribute('aria-labelledby').split(' ')].map((i) => document.getElementById(i)?.textContent || '').join(' ').trim())
    || ((e.labels && e.labels[0] && e.labels[0].textContent) || '').trim() || (e.tagName === 'INPUT' && /button|submit/.test(e.type) ? e.value : '') || (e.textContent || '').trim() || (e.getAttribute('title') || '').trim() || (e.getAttribute('placeholder') || '').trim() || (e.getAttribute('alt') || '').trim();
  return [...document.querySelectorAll('button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=option],canvas[role=img],a[href]')].filter(vis).filter((e) => !nameOf(e)).map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + e.className);
})()`;

test('accessibility: list, chips, tabs, palette, names, drawer and graph', { skip: !CHROME && 'Chrome not found', timeout: 120000 }, async () => {
  const s = await session({ files: { 'Home.md': '# Home\nsee [[Two]] #idea', 'Two.md': '# Two\n#idea and more', 'Folder/Inner.md': 'inner' } });
  try {
    const { ev, until, key, typeInto } = s;
    // the note list is a listbox with a single tab stop; arrows move, Enter opens the note and moves focus into it
    assert.equal(await ev("document.querySelector('#list').getAttribute('role')"), 'listbox');
    assert.equal(await ev("[...document.querySelectorAll('#list .item')].every((i) => i.getAttribute('role') === 'option' && i.hasAttribute('aria-selected'))"), true);
    assert.equal(await ev("document.querySelectorAll('#list .item[tabindex=\"0\"]').length"), 1, 'one tab stop');
    await ev("document.querySelector('#list .item[tabindex=\"0\"]').focus()"); const first = await ev("document.activeElement.dataset.note");
    await key('ArrowDown'); assert.notEqual(await ev("document.activeElement.dataset.note"), first); assert.equal(await ev("document.querySelectorAll('#list .item[tabindex=\"0\"]').length"), 1, 'still one tab stop after moving');
    await key('Home'); assert.equal(await ev("document.activeElement.dataset.note"), first); await key('End');
    const target = await ev("document.activeElement.dataset.note"); await key('Enter');
    await until(`cur === ${JSON.stringify(target)}`, 'Enter opens the note'); await until("document.activeElement && document.activeElement.id === 'ed'", 'focus moves into the editor');
    assert.equal(await ev("document.querySelector('#ed').getAttribute('aria-label')"), 'Note editor');
    // Shift+F10 / the Menu key opens the context menu from the keyboard
    await ev("document.querySelector('#list .item').focus()"); await key('F10', { shift: true }); await until("getComputedStyle(document.querySelector('#ctx')).display !== 'none'", 'context menu from the keyboard'); await key('Escape');

    // chips are toggle buttons; Enter filters the list
    assert.equal(await ev("[...document.querySelectorAll('#tags .chip[data-tag]')].every((c) => c.getAttribute('role') === 'button' && c.tabIndex === 0 && c.hasAttribute('aria-pressed'))"), true);
    await ev("document.querySelector('#tags .chip[data-tag=\"idea\"]').focus()"); await key('Enter');
    await until("document.querySelector('#tags .chip[data-tag=\"idea\"]').getAttribute('aria-pressed') === 'true'", 'chip pressed'); assert.equal(await ev("document.querySelectorAll('#list .item').length"), 2);
    await ev("document.querySelector('#tags .chip[data-tag=\"idea\"]').click()");

    // tabs: arrow keys move between tabs (only the selected one is a tab stop)
    await ev("openInNewTab('Two', false)"); await until("document.querySelectorAll('#tabs .tab').length === 2", 'two tabs');
    assert.equal(await ev("document.querySelectorAll('#tabs .tab[tabindex=\"0\"]').length"), 1);
    await ev("document.querySelector('#tabs .tab.on').focus()"); const was = await ev('cur'); await key('ArrowLeft'); await until(`cur !== ${JSON.stringify(was)}`, 'ArrowLeft switches tab');
    await until("document.activeElement && document.activeElement.classList.contains('tab') && document.activeElement.getAttribute('aria-selected') === 'true'", 'focus follows the selected tab');

    // the palette is a combobox over a listbox; the highlighted row is announced through aria-activedescendant
    await ev("swOpen('cmds')"); await s.sleep(150);
    assert.equal(await ev("document.querySelector('#swq').getAttribute('role')"), 'combobox'); assert.equal(await ev("document.querySelector('#swl').getAttribute('role')"), 'listbox');
    await typeInto('#swq', 'graph'); await s.sleep(150);
    let active = await ev("document.querySelector('#swq').getAttribute('aria-activedescendant')"); assert.ok(active, 'has an active descendant');
    assert.equal(await ev(`document.getElementById(${JSON.stringify(active)}).getAttribute('aria-selected')`), 'true'); assert.equal(await ev(`document.getElementById(${JSON.stringify(active)}).getAttribute('role')`), 'option');
    await typeInto('#swq', 'e'); await s.sleep(150); const a1 = await ev("document.querySelector('#swq').getAttribute('aria-activedescendant')"); await key('ArrowDown'); await s.sleep(150);
    assert.notEqual(await ev("document.querySelector('#swq').getAttribute('aria-activedescendant')"), a1, 'ArrowDown moves the announced row');
    await key('Escape'); await s.sleep(100);

    // every visible control has an accessible name: the plain view, the preview, the find bar and the graph
    assert.deepEqual(await ev(NAMELESS), [], 'unnamed controls in the editor view');
    await ev("preview = true; renderPane()"); await s.sleep(200); assert.deepEqual(await ev(NAMELESS), [], 'unnamed controls in the reading view');
    await ev("openFind && openFind()"); await s.sleep(200); assert.deepEqual(await ev(NAMELESS), [], 'unnamed controls with the find bar open'); assert.equal(await ev("document.querySelector('#frc').getAttribute('aria-live')"), 'polite');
    await ev("document.querySelector('#frx')?.click(); graphOn = true; renderPane()"); await until("!!document.querySelector('#gc')", 'graph'); await s.sleep(300);
    assert.equal(await ev("document.querySelector('#gc').getAttribute('role')"), 'img'); assert.match(await ev("document.querySelector('#gc').getAttribute('aria-label')"), /Graph of your notes/);
    assert.equal(await ev("getComputedStyle(document.querySelector('#gc')).touchAction"), 'none'); assert.deepEqual(await ev(NAMELESS), [], 'unnamed controls with the graph');
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});

test('accessibility: on a phone the drawer reports its state and hides the page behind it', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'Home.md': '# Home' }, size: [390, 800], mobile: true });
  try {
    const { ev } = s;
    assert.equal(await ev("document.querySelector('#menu').getAttribute('aria-expanded')"), 'false'); assert.equal(await ev("document.querySelector('#main').inert"), false);
    await ev("document.querySelector('#menu').click()"); await s.sleep(250);
    assert.equal(await ev("document.querySelector('#menu').getAttribute('aria-expanded')"), 'true'); assert.equal(await ev("document.querySelector('#main').inert"), true, 'the page behind the open drawer is unreachable');
    await ev("document.body.classList.remove('side-open')"); await s.sleep(250);
    assert.equal(await ev("document.querySelector('#menu').getAttribute('aria-expanded')"), 'false'); assert.equal(await ev("document.querySelector('#main').inert"), false);
  } finally { s.close(); }
});
