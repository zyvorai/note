// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Big vaults: the note list shows a page at a time, and the graph neither freezes the tab nor burns battery on a settled layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

const many = (n, f) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`Note ${String(i).padStart(4, '0')}.md`, f(i)]));

test('list: a page of 200, "Show more" adds more and keeps keyboard focus, a new search starts over', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: many(450, (i) => `# n${i}\n${i % 2 ? 'odd' : 'even'} #t${i % 3}`) });
  try {
    const { ev, until, key, typeInto } = s;
    const rows = () => ev("document.querySelectorAll('#list .item:not(.more)').length"), more = () => ev("document.querySelector('#moreRows')?.textContent || ''");
    assert.equal(await rows(), 200); assert.match(await more(), /^Show 250 more · 250 not shown$/);
    await ev("document.querySelector('#list .item').focus()"); await key('End'); assert.equal(await ev("document.activeElement.id"), 'moreRows', 'the keyboard can reach it');
    await key('Enter'); await until("document.querySelectorAll('#list .item:not(.more)').length === 450", 'all rows after one click'); assert.equal(await more(), '', 'nothing left to show');
    assert.equal(await ev("document.activeElement.classList.contains('item') && !!document.activeElement.dataset.note"), true, 'focus lands on a note row, not nowhere');
    // searching narrows and starts from the first page; clearing returns to a page of 200
    await typeInto('#q', 'odd'); await ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"); assert.equal(await rows(), 200); assert.match(await more(), /Show 25 more · 25 not shown/);
    await typeInto('#q', ''); await ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"); assert.equal(await rows(), 200); assert.match(await more(), /250 not shown/);
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});

test('graph: a large vault shows the open note\'s neighbourhood, and a settled graph stops animating until touched', { skip: !CHROME && 'Chrome not found', timeout: 120000 }, async () => {
  const files = many(1600, (i) => `# n${i}\nlinks to [[Note ${String((i + 1) % 1600).padStart(4, '0')}]] and [[Note ${String((i * 7) % 1600).padStart(4, '0')}]]`);
  const s = await session({ files });
  try {
    const { ev, until } = s;
    await ev("open('Note 0005', false)"); await until("cur === 'Note 0005'", 'open');
    await ev("graphOn = true; renderPane()"); await until("!!document.querySelector('#gc')", 'graph');
    const n = Number(await ev("document.querySelector('#gc').dataset.nodes")); assert.ok(n > 1 && n <= 1500, 'capped: ' + n); assert.ok(n < 40, 'a neighbourhood, not the whole vault: ' + n);
    assert.match(await ev("document.querySelector('#gmode').textContent"), /Around “Note 0005”.*large vault/);
    // with nothing open there is no neighbourhood: the best-connected notes are kept instead
    await ev("showEmpty(); graphOn = true; renderPane()"); await until("!!document.querySelector('#gc') && Number(document.querySelector('#gc').dataset.nodes) > 0", 'graph without a note');
    assert.equal(Number(await ev("document.querySelector('#gc').dataset.nodes")), 1500); assert.match(await ev("document.querySelector('#gmode').textContent"), /The 1500 best-connected notes/);
    s.errors.length = 0;
  } finally { s.close(); }
  // a small graph: the animation loop goes to sleep once settled, and wakes on interaction
  const t = await session({ files: { 'A.md': '[[B]] [[C]]', 'B.md': '[[C]]', 'C.md': 'c', 'D.md': '[[A]]' } });
  try {
    const { ev, until } = t;
    await ev("graphOn = true; renderPane()"); await until("!!document.querySelector('#gc')", 'graph');
    await ev("document.querySelector('#gc').dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }))");       // taking over the view lets the layout be judged settled
    await until('gRaf === 0', 'the loop sleeps once the layout has settled', 150);
    const painted = await ev("(() => { const c = document.querySelector('#gc'); return c.toDataURL().length; })()");
    await ev("document.querySelector('#gc').dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50, bubbles: true }))");
    assert.notEqual(await ev('gRaf'), 0, 'an interaction wakes it'); await until('gRaf === 0', 'and it goes back to sleep', 150);
    assert.ok(painted > 100); assert.deepEqual(t.errors, []);
  } finally { t.close(); }
});
