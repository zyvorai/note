// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Save safety: a failed save is visible and retried, edits in several notes survive a server outage, and closing the page saves what it can.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

test('save safety: outage, retry, two notes with unsaved edits, close and hide', { skip: !CHROME && 'Chrome not found', timeout: 120000 }, async () => {
  const s = await session({ files: { 'One.md': 'one', 'Two.md': 'two' } });
  try {
    const { ev, until } = s;
    const edit = (text) => ev(`(()=>{const e=document.querySelector('#ed');e.value=${JSON.stringify(text)};onInput();})()`);
    await ev("open('One', false)"); await until("cur === 'One' && !!document.querySelector('#ed')", 'open one');

    // the server goes away: the failure is visible, plain-language, and the text stays in the window
    s.stopServer(); await s.sleep(300);
    await edit('one, edited while offline');
    await until("document.querySelector('#status').textContent === 'Not saved'", 'not saved');
    assert.equal(await ev("document.querySelector('#status').classList.contains('err')"), true);
    const toast = await ev("document.querySelector('.toast.error span').textContent");
    assert.match(toast, /not reachable/); assert.doesNotMatch(toast, /Failed to fetch/); assert.equal(await ev("document.querySelector('.toast.error button').textContent"), 'Retry now');
    assert.equal(await ev("unsaved.has('One')"), true);

    // switching notes after a failed save must not orphan the first note: both stay unsaved, and a reload from disk cannot replace either
    await ev("open('Two', false)"); await until("cur === 'Two' && !!document.querySelector('#ed')", 'open two');
    await edit('two, edited while offline');
    assert.deepEqual((await ev('[...unsaved]')).sort(), ['One', 'Two']);
    assert.equal(await ev("notes.get('One').text"), 'one, edited while offline');
    assert.equal(await ev("document.querySelectorAll('.toast.error').length"), 1, 'repeated failures do not stack toasts');

    // the server returns: the automatic retry (or Retry now) saves both, then the error toast goes away
    await s.startServer(); await ev("document.querySelector('.toast.error button').click()");
    await until("unsaved.size === 0", 'both saved', 100);
    assert.equal(s.read('One.md'), 'one, edited while offline'); assert.equal(s.read('Two.md'), 'two, edited while offline');
    await until("document.querySelector('#status').textContent === 'Saved'", 'saved state'); assert.equal(await ev("document.querySelectorAll('.toast.error').length"), 0);

    // automatic retry without a click, and clicking the status text retries too
    s.stopServer(); await s.sleep(300); await edit('two, third edit'); await until("document.querySelector('#status').textContent === 'Not saved'", 'not saved again');
    await s.startServer(); await until("unsaved.size === 0", 'auto retry saved it', 100); assert.equal(s.read('Two.md'), 'two, third edit');
    s.stopServer(); await s.sleep(300); await edit('two, fourth'); await until("document.querySelector('#status').textContent === 'Not saved'", 'not saved a third time'); await s.startServer();
    await ev("document.querySelector('#status').click()"); await until("unsaved.size === 0", 'click on the status retried', 60); assert.equal(s.read('Two.md'), 'two, fourth');

    // hiding the page saves immediately instead of waiting for the timer
    await edit('two, hidden'); await ev('clearTimeout(timer)');
    await ev("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))");
    await until("unsaved.size === 0", 'visibilitychange flushed', 40); assert.equal(s.read('Two.md'), 'two, hidden');
    await ev("delete document.visibilityState");

    // closing: a keepalive request saves plain-text notes even though the page cannot wait
    await edit('two, closing'); await ev('clearTimeout(timer)'); await ev("window.dispatchEvent(new Event('pagehide'))");
    for (let i = 0; i < 40 && s.read('Two.md') !== 'two, closing'; i++) await s.sleep(100); assert.equal(s.read('Two.md'), 'two, closing');
    await until("unsaved.size === 0", 'flushed', 40);
    // closing asks the browser to confirm only when the close-time save cannot be guaranteed: not for an ordinary pending autosave…
    const asks = () => ev("(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()");
    assert.equal(await asks(), false, 'a clean page closes silently');
    await ev('clearTimeout(timer)'); await edit('two, pending autosave'); await ev('clearTimeout(timer)');
    assert.equal(await asks(), false, 'a pending plain-text autosave is sent by the keepalive request, so there is nothing to ask');
    await until("unsaved.size === 0", 'flushed by the beforeunload handler', 40);
    // …but yes once saving is already failing, or for an encrypted note that cannot be saved synchronously
    s.stopServer(); await s.sleep(200); await edit('two, server is down'); await until("document.querySelector('#status').textContent === 'Not saved'", 'failing');
    assert.equal(await asks(), true, 'a failing save asks before the page is closed');
    await s.startServer(); await until("unsaved.size === 0", 'recovered', 100);
    assert.equal(await asks(), false);
    await ev("(() => { const n = notes.get('Two'); n.cipher = '-----BEGIN PLAINNOTE ENCRYPTED NOTE-----'; unsaved.add('Two'); })()");
    assert.equal(await asks(), true, 'an unsaved encrypted note asks'); await ev("(() => { const n = notes.get('Two'); delete n.cipher; unsaved.delete('Two'); })()");
  } finally { s.close(); }
});
