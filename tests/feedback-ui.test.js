// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Feedback in the real app: save state vs. one-off messages, error toasts, screen-reader announcements.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

test('feedback: save state stays, messages fade back to it, errors become toasts, and screen readers hear messages', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'One.md': '# One\nbody' } });
  try {
    const { ev, until } = s;
    await ev("open('One', false)"); await until("cur === 'One' && !!document.querySelector('#ed')", 'open');
    await ev("(()=>{const e=document.querySelector('#ed');e.value+=' more';onInput();})()");
    assert.equal(await ev("document.querySelector('#status').textContent"), 'Editing…');
    assert.equal(await ev("document.querySelector('#sr').textContent"), '', 'typing is not announced to screen readers');
    await until("document.querySelector('#status').textContent === 'Saved'", 'saved');
    assert.match(await ev("document.querySelector('#status').title"), /^Saved at /);

    // a one-off message replaces the save state, is announced, then gives way to it again
    await ev('SAY_MS = 150; say("Moved to Archive")');
    assert.equal(await ev("document.querySelector('#status').textContent"), 'Moved to Archive'); assert.equal(await ev("document.querySelector('#sr').textContent"), 'Moved to Archive');
    assert.equal(await ev("document.querySelectorAll('.toast').length"), 0, 'plain information does not pop a toast');
    await until("document.querySelector('#status').textContent === 'Saved'", 'back to the save state');

    // failures are red, raise a toast that stays, and read as errors
    await ev('say("Upload failed: too big")');
    assert.equal(await ev("document.querySelector('#status').classList.contains('err')"), true);
    assert.equal(await ev("document.querySelector('.toast.error span').textContent"), 'Upload failed: too big'); assert.equal(await ev("!!document.querySelector('.toast.error .toast-x')"), true);
    await s.sleep(400); assert.equal(await ev("document.querySelectorAll('.toast.error').length"), 1, 'an error toast does not vanish by itself');
    await ev("document.querySelector('.toast.error .toast-x').click()"); assert.equal(await ev("document.querySelectorAll('.toast').length"), 0);

    // a very long message cannot reflow the toolbar
    await ev('say("x".repeat(400))'); const w = await ev("document.querySelector('#status').getBoundingClientRect().width"); assert.ok(w < 700, 'status width is capped: ' + w);
    assert.equal(await ev("getComputedStyle(document.querySelector('#status')).textOverflow"), 'ellipsis');
    assert.equal(await ev("document.querySelector('#sr').getAttribute('role')"), 'status');

    // an action on a message (used for Undo) shows a button that runs once
    await ev('window.__ran = 0; say("Did a thing", { action: { label: "Undo", run: () => window.__ran++ } })'); await ev("document.querySelector('.toast button').click()");
    assert.equal(await ev('window.__ran'), 1); assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
