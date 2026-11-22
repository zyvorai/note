// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Reloading the note list fetches only what changed, keeps unsaved edits, and still works against an older server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { session, CHROME } = require('./helpers/session');

test('load: only changed notes are fetched; unchanged ones keep their parsed state; unsaved edits survive', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'A.md': 'alpha', 'B.md': 'beta', 'C.md': 'gamma' } });
  try {
    const { ev, until } = s;
    await ev(`window.__calls = []; const f = window.__origFetch = window.fetch; window.fetch = (u, o) => { window.__calls.push([String(u), o && o.body ? String(o.body) : '']); return f(u, o); };`);
    const calls = () => ev('window.__calls.filter((c) => /\\/api\\/notes/.test(c[0])).map((c) => c[0] + (c[1] ? " " + c[1] : ""))');
    // nothing changed: a metadata request and no bodies at all
    await ev('window.__same = notes.get("A"); window.__calls = []'); await ev('load()'); assert.deepEqual(await calls(), ['/api/notes?meta=1']);
    assert.equal(await ev('notes.get("A") === window.__same'), true, 'an unchanged note is the very same object');
    // one note changed on disk (bumping its mtime), one added, one deleted, one renamed
    await new Promise((r) => setTimeout(r, 30)); fs.writeFileSync(path.join(s.dir, 'B.md'), 'beta changed'); fs.writeFileSync(path.join(s.dir, 'New.md'), 'fresh'); fs.rmSync(path.join(s.dir, 'C.md')); fs.renameSync(path.join(s.dir, 'A.md'), path.join(s.dir, 'A2.md'));
    await ev('window.__calls = []'); await ev('load()');
    const c = await calls(); assert.equal(c.length, 2); assert.equal(c[0], '/api/notes?meta=1'); const asked = JSON.parse(c[1].replace('/api/notes/read ', '')).names.sort();
    assert.deepEqual(asked, ['A2', 'B', 'New'], 'the renamed, changed and new notes only (a rename keeps its mtime but is a new name)');
    assert.deepEqual((await ev('[...notes.keys()].sort()')), ['A2', 'B', 'New']); assert.equal(await ev('notes.get("B").text'), 'beta changed'); assert.equal(await ev('notes.get("New").text'), 'fresh');
    // overlapping reloads cannot let an older result overwrite a newer one (they run in order)
    await ev("window.__a = load(); window.__a2 = load()"); fs.writeFileSync(path.join(s.dir, 'Race.md'), 'added between the reloads'); await ev("window.__b = load(); Promise.all([window.__a, window.__a2, window.__b]).then(() => { window.__raceDone = true; })");
    await until('window.__raceDone === true', 'reloads finished'); assert.equal(await ev('notes.has("Race")'), true, 'a note added while an older reload was still running survives it');
    // an unsaved edit is never replaced by a reload, even when the file changed on disk
    await ev("open('B', false)"); await until("cur === 'B' && !!document.querySelector('#ed')", 'open B');
    await ev("(()=>{const e=document.querySelector('#ed');e.value='typed but not saved yet';e.dispatchEvent(new Event('input'));clearTimeout(timer);})()");
    await new Promise((r) => setTimeout(r, 30)); fs.writeFileSync(path.join(s.dir, 'B.md'), 'changed by something else');
    await ev('load()'); assert.equal(await ev('notes.get("B").text'), 'typed but not saved yet');
    // an older server that ignores ?meta=1 and sends everything still works, and we stop asking for the metadata form
    await ev("unsaved.clear(); dirty = false; metaOK = true; window.fetch = (u, o) => { window.__calls.push([String(u), o && o.body ? String(o.body) : '']); return window.__origFetch(String(u) === '/api/notes?meta=1' ? '/api/notes' : u, o); }");
    await ev('window.__calls = []'); await ev('load()'); assert.equal(await ev('metaOK'), false, 'learned that the server only has the full listing');
    assert.deepEqual(await ev('[...notes.keys()].sort()'), ['A2', 'B', 'New', 'Race']); assert.equal(await ev('notes.get("B").text'), 'changed by something else');
    assert.deepEqual(await calls(), ['/api/notes?meta=1'], 'no batch reads needed: the full listing already had the text');
    await ev('window.__calls = []'); await ev('load()'); assert.deepEqual(await calls(), ['/api/notes'], 'from then on it asks for the full listing directly');
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
