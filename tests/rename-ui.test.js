// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Renaming a note updates the links that point at it, and the rename is not "done" until those saves are.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

test('rename: links in other notes are saved before it finishes, and failures are reported', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'Target.md': 'target', 'A.md': 'see [[Target]] and [[Target#Part|alias]]', 'B.md': 'also [[Target]]', 'C.md': 'no link' } });
  try {
    const { ev, until } = s;
    // when the promise resolves, the links are already on disk (no waiting, no polling)
    assert.equal(await ev("renameNote('Target', 'Renamed')"), true);
    assert.equal(s.read('A.md'), 'see [[Renamed]] and [[Renamed#Part|alias]]'); assert.equal(s.read('B.md'), 'also [[Renamed]]'); assert.equal(s.read('C.md'), 'no link'); assert.ok(s.exists('Renamed.md') && !s.exists('Target.md'));
    assert.equal(await ev("document.querySelectorAll('.toast.error').length"), 0, 'a clean rename says nothing');
    // one of the link updates fails: the rename still happens, and you are told which links are stale
    await ev("const f = window.fetch; window.fetch = (u, o) => (o && o.method === 'PUT' && /name=B(&|$)/.test(String(u)) ? Promise.reject(new Error('Failed to fetch')) : f(u, o))");
    assert.equal(await ev("renameNote('Renamed', 'Again')"), true); assert.ok(s.exists('Again.md'));
    assert.equal(s.read('A.md'), 'see [[Again]] and [[Again#Part|alias]]', 'the notes that could be saved were'); assert.equal(s.read('B.md'), 'also [[Renamed]]', 'the one that could not still has the old link');
    await until("[...document.querySelectorAll('.toast.error span')].some((t) => /Renamed, but 1 note could not be updated and still links to “Renamed”/.test(t.textContent))", 'a clear warning');
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
