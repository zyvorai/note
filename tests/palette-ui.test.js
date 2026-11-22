// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// The command palette and quick switcher, the shortcut cheat-sheet, and the editor's formatting shortcuts, in the real app.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

test('palette: grouped, fuzzy with highlights, recents, platform hints, switcher with aliases and new tab', { skip: !CHROME && 'Chrome not found', timeout: 120000 }, async () => {
  const s = await session({ files: { 'Meeting Notes.md': 'm', 'Projects/Plan Alpha.md': 'p', 'Zed.md': '---\naliases: [Zebra Crossing]\n---\nz', 'Alpha.md': 'a' } });
  try {
    const { ev, until, key, typeInto } = s;
    const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const rowsText = () => ev("[...document.querySelectorAll('#swl .item')].map((i) => i.textContent)");
    // commands, nothing typed: grouped under headings, every command present exactly once, with key caps
    await ev("swOpen('cmds')"); await settle();
    const heads = await ev("[...document.querySelectorAll('#swl .gh')].map((h) => h.textContent)");
    assert.deepEqual(heads.slice(0, 3), ['Notes', 'View', 'Find']); assert.ok(heads.includes('Privacy') && heads.includes('Help and settings')); assert.ok(!heads.includes('Recent'), 'no recents yet');
    assert.equal(await ev("document.querySelectorAll('#swl .item').length === COMMANDS.length"), true, 'every command is listed once');
    assert.match((await rowsText()).find((t) => /^New note/.test(t)), /(⌘|Ctrl\+)N$/);
    // typing ranks by fuzzy match and highlights the matched letters
    await typeInto('#swq', 'tg'); await settle(); assert.equal((await rowsText())[0].replace(/(⌘|Ctrl\+).*$/, '').trim(), 'Toggle graph view'); assert.ok(await ev("document.querySelector('#swl .item.on mark')"), 'matched letters are marked');
    assert.equal(await ev("[...document.querySelectorAll('#swl .item')].every((i) => i.querySelector('mark'))"), true);
    await typeInto('#swq', 'zzzzqq'); await settle(); assert.equal(await ev("document.querySelector('#swl .empty')?.textContent"), 'No matching command');
    // choosing a command remembers it: it leads the list next time, under "Recent"
    await typeInto('#swq', 'dark'); await typeInto('#swq', 'theme'); await settle(); await key('Enter'); await s.sleep(200);
    await ev("swOpen('cmds')"); await settle(); assert.deepEqual((await ev("[...document.querySelectorAll('#swl .gh')].map((h) => h.textContent)"))[0], 'Recent');
    assert.match((await rowsText())[0], /^Cycle theme/); await key('Escape');
    // your own shortcut replaces the built-in hint
    await ev("settings.hotkeys = { theme: 'alt+j' }"); assert.equal(await ev("cmdHint(COMMANDS.find((c) => c.id === 'theme')) === MD.comboLabel('alt+j', isMac)"), true); await ev("settings.hotkeys = {}");

    // the quick switcher: initials match, folders are dimmed, aliases find notes, Ctrl/Cmd+Enter opens a new tab
    await ev("swOpen()"); await typeInto('#swq', 'mn'); await settle(); assert.equal((await rowsText())[0], 'Meeting Notes');
    await typeInto('#swq', 'alpha'); await settle(); const alpha = await rowsText(); assert.ok(alpha[0].startsWith('Alpha'), 'the exact name leads: ' + alpha[0]); assert.ok(alpha.some((t) => /^Projects\/Plan Alpha/.test(t)));
    assert.equal(await ev("document.querySelector('#swl .fp')?.textContent"), 'Projects/', 'the folder part is dimmed');
    await typeInto('#swq', 'zebra'); await settle(); assert.match((await rowsText())[0], /^Zedalias: Zebra Crossing$/);
    await typeInto('#swq', 'meeting'); await settle(); await key('Enter', { ctrl: true }); await until("document.querySelectorAll('#tabs .tab').length === 2 && cur === 'Meeting Notes'", 'opened in a new tab');
    await ev("swOpen()"); await typeInto('#swq', 'brand new idea'); await settle(); assert.equal((await rowsText()).pop(), 'Create “brand new idea”'); await key('Escape');

    // the cheat-sheet: Ctrl/Cmd+/ lists commands (with your hints) and the editor keys; Esc closes
    await key('/', { ctrl: true }); await until("!!document.querySelector('#shortcuts')", 'cheat-sheet');
    const sheet = await ev("document.querySelector('#shortcuts').textContent"); for (const t of ['Writing', 'Strikethrough', 'Tick or untick a task', 'Toggle edit / preview', 'Notes', 'New note']) assert.ok(sheet.includes(t), t);
    await key('Escape'); assert.equal(await ev("!!document.querySelector('#shortcuts')"), false);
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});

test('formatting shortcuts in the editor', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'N.md': 'make word bold\nplain line' } });
  try {
    const { ev, until, key } = s;
    await ev("open('N', false)"); await until("cur === 'N' && !!document.querySelector('#ed')", 'open');
    const select = (a, b) => ev(`(() => { const e = document.querySelector('#ed'); e.focus(); e.setSelectionRange(${a}, ${b}); })()`), text = () => ev("document.querySelector('#ed').value");
    await select(5, 9); await key('X', { ctrl: true, shift: true }); assert.equal(await text(), 'make ~~word~~ bold\nplain line', 'strikethrough');
    await key('X', { ctrl: true, shift: true }); assert.equal(await text(), 'make word bold\nplain line', 'pressing it again removes it');
    await select(5, 9); await key('M', { ctrl: true, alt: true }); assert.equal(await text(), 'make ==word== bold\nplain line', 'highlight'); await key('M', { ctrl: true, alt: true });
    await select(5, 9); await key('C', { ctrl: true, alt: true }); assert.equal(await text(), 'make `word` bold\nplain line', 'inline code'); await key('C', { ctrl: true, alt: true });
    await select(3, 3); await key('H', { ctrl: true, alt: true }); assert.match(await text(), /^# make word bold/, 'cycles the heading level'); await key('H', { ctrl: true, alt: true }); assert.match(await text(), /^## make word bold/);
    await until("!dirty", 'saved'); assert.match(s.read('N.md'), /^## make word bold/); assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
