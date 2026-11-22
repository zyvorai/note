// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Undo for the actions that used to need a confirmation: deleting a note, replacing across notes, restoring a history version.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');
const C = require('../public/crypto.js');

test('undo: delete (including an unlocked encrypted note), replace in all notes, history restore', { skip: !CHROME && 'Chrome not found', timeout: 120000 }, async () => {
  const env = (await C.encryptWithPassphrase('# Secret\nthe vault', 'correct horse battery')).envelope;
  const s = await session({ files: { 'A.md': 'foo one\nfoo two', 'B.md': 'a foo here', 'C.md': 'no match', 'Keep.md': 'foo in a note I will edit', 'Vault.md': env } });
  try {
    const { ev, until, typeInto, key } = s;
    const undo = () => ev("document.querySelector('.toast button').click()");

    // delete is instant; Undo restores the same text
    await ev("open('A', false)"); await until("cur === 'A'", 'A'); await ev("document.querySelector('#del').click()"); await until("!notes.has('A')", 'deleted');
    assert.ok(!s.exists('A.md')); assert.equal(await ev("document.querySelector('.toast button').textContent"), 'Undo');
    await undo(); await until("notes.has('A') && cur === 'A'", 'restored'); assert.equal(s.read('A.md'), 'foo one\nfoo two');
    // …and so does an unlocked encrypted note, without asking for the passphrase again
    await ev("open('Vault', false)"); await until("cur === 'Vault' && !!document.querySelector('.lockcard')", 'locked');
    await ev("document.querySelector('#lkp').value='correct horse battery';document.querySelector('#lkf').requestSubmit()"); await until("!!document.querySelector('#ed')", 'unlocked');
    await ev("document.querySelector('#del').click()"); await until("!notes.has('Vault')", 'vault deleted'); assert.ok(!s.exists('Vault.md'));
    await undo(); await until("notes.has('Vault') && !!notes.get('Vault').enc", 'vault restored unlocked'); assert.equal(s.read('Vault.md'), env);
    assert.equal(await ev("notes.get('Vault').text"), '# Secret\nthe vault');

    // replace in all notes: Enter in the replace field does not apply; the button does; Undo puts every note back
    await ev('openGlobalFind()'); await typeInto('#gfq', 'foo'); await typeInto('#gfr', 'bar'); await ev("document.querySelector('#gfr').focus()"); await key('Enter'); await s.sleep(300);
    assert.equal(s.read('B.md'), 'a foo here', 'Enter in the replace field must not apply anything'); assert.equal(await ev("document.querySelector('#gf').style.display"), 'flex');
    await ev("document.querySelector('#gfa').click()"); await until("document.querySelector('.toast button')", 'replace toast');
    assert.equal(s.read('A.md'), 'bar one\nbar two'); assert.equal(s.read('B.md'), 'a bar here'); assert.equal(s.read('Keep.md'), 'bar in a note I will edit'); assert.equal(s.read('C.md'), 'no match');
    // a note edited after the replace is not clobbered by Undo
    await ev("open('Keep', false)"); await until("cur === 'Keep' && !!document.querySelector('#ed')", 'keep'); await ev("(()=>{const e=document.querySelector('#ed');e.value+=' EDITED';onInput();})()"); await until("!dirty", 'saved edit');
    await ev("document.querySelector('.toast button')?.click()");
    if (!(await ev("document.querySelector('.toast.info,.toast')?.textContent.includes('Undid')"))) await until("[...document.querySelectorAll('.toast, #status')].some(e => /Undid the replace/.test(e.textContent))", 'undone');
    assert.equal(s.read('A.md'), 'foo one\nfoo two'); assert.equal(s.read('B.md'), 'a foo here');
    assert.equal(s.read('Keep.md'), 'bar in a note I will edit EDITED', 'the note edited since is left alone');
    assert.match(await ev("document.querySelector('#status').textContent"), /Undid the replace in 2 notes; 1 changed since and was left alone/);

    // history restore: Undo returns to what was there
    const before = await ev("notes.get('B').text"); await ev("open('B', false)"); await until("cur === 'B'", 'B');
    await ev("(()=>{const e=document.querySelector('#ed');e.value='second version';onInput();})()"); await until("!dirty", 'saved');
    await ev("void openHistory()"); await until("document.querySelectorAll('#hist li[data-id]').length >= 1", 'history');
    await ev("document.querySelector('#hist li[data-id]').click()"); await until("!document.querySelector('#hr').disabled", 'version loaded (the placeholder text does not count)'); await ev("document.querySelector('#hr').click()");
    await until("notes.get('B').text === " + JSON.stringify(before), 'restored the older version'); await until("!dirty", 'restore saved');
    await ev("document.querySelector('.toast button').click()"); await until("notes.get('B').text === 'second version'", 'undo of the restore');
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
