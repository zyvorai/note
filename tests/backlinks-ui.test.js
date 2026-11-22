// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Backlinks are computed from per-note caches; this checks the results stay right as notes are edited, added, renamed and given aliases.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

test('backlinks: correct results, and the caches follow edits, new notes, renames and aliases', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: {
    'Target.md': '# Target\nlinks to [[Other]] and [[Missing note]]', 'Other.md': 'other',
    'A.md': 'see [[Target]]', 'B.md': 'see [[target|shown text]] (case and display text)', 'Deep/C.md': 'see [[Target#Some heading]] and [[Target^blk]]',
    'D.md': '---\naliases: [Tee]\n---\nbody', 'E.md': 'via an alias: [[tee]]',
    'Self.md': '# Self\njump to [[#Heading]] in this same note', 'Mention.md': 'plain text that mentions Target without linking', 'Dup.md': 'first of two notes with the same last name', 'Folder/Dup.md': 'second',
  } });
  try {
    const { ev, until } = s;
    const back = async (name) => { await ev(`cur = ${JSON.stringify(name)}; renderBack()`); return ev("(() => { const b = document.querySelector('#back'); const part = (id) => [...b.querySelectorAll('#' + id + ' a[data-note]')].map((a) => a.dataset.note).sort(); const linked = (b.textContent.match(/^Linked from:(.*?)(Links to:|Unlinked|$)/s) || [])[1]; return { from: [...b.querySelectorAll(':scope > a[data-note]')].map((a) => a.dataset.note).sort(), out: part('outgoing'), um: part('um') }; })()"); };
    const t = await back('Target');
    assert.deepEqual(t.from, ['A', 'Deep/C', 'B'].sort(), 'plain, case-insensitive, with display text, with heading and block anchors, from a subfolder');
    assert.ok(!t.from.includes('Self'), 'a [[#Heading]] link inside another note is a link to that note, not to the one you have open');
    assert.deepEqual(t.out, ['Other'], 'outgoing links resolve; a missing note is not listed');
    assert.ok(t.um.includes('Mention'), 'a note that only mentions the name is an unlinked mention'); assert.ok(!t.um.includes('A'), 'a linked note is not');
    // an alias counts: [[tee]] links to D
    assert.deepEqual((await back('D')).from, ['E'], 'a link through a frontmatter alias is a backlink');
    // editing a note changes the result (the per-note cache is keyed by its text)
    await ev("notes.get('A').text = 'no link any more'"); assert.ok(!(await back('Target')).from.includes('A'));
    await ev("notes.get('A').text = 'again [[Target]]'"); assert.ok((await back('Target')).from.includes('A'));
    // a new note appears, a note is renamed, an alias is added: indexes keyed on the set of notes / aliases rebuild
    await ev("notes.set('Fresh', { name: 'Fresh', text: 'points at [[Other]]', mtime: Date.now(), base: 1 })"); assert.deepEqual((await back('Other')).from, ['Fresh', 'Target']);
    await ev("notes.delete('Fresh')"); assert.deepEqual((await back('Other')).from, ['Target']);
    await ev("notes.get('Other').text = '---\\naliases: [Zeta]\\n---\\nother'; notes.get('A').text = 'now [[zeta]]'"); await ev('aliasAt = 0');                      // the alias index refreshes on its next pass
    assert.ok((await back('Other')).from.includes('A'), 'a newly added alias makes an existing link resolve');
    await ev("notes.get('Other').text = 'other, alias removed'"); await ev('aliasAt = 0'); assert.ok(!(await back('Other')).from.includes('A'), 'removing the alias unlinks it again');
    // duplicates: the first note in list order wins a bare name, exactly as before
    assert.equal(await ev("resolve('dup')"), 'Dup', 'a bare name goes to the first note in list order, as before'); assert.equal(await ev("resolve('DUP')"), 'Dup'); assert.equal(await ev("resolve('folder/dup')"), 'Folder/Dup'); assert.equal(await ev("resolve('nope')"), null);
    // the cached helpers agree with a brute-force check
    assert.equal(await ev("[...notes.values()].every((n) => lowerOf(n) === n.text.toLowerCase() && [...tagsCached(n)].join() === [...tagsOf(n.text)].join())"), true);
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
