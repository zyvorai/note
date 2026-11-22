// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Phones and tablets, emulated in headless Chrome with touch: target sizes, the keyboard on a tablet, pull-to-refresh, tap to edit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { session, CHROME } = require('./helpers/session');

const SMALL = `(() => { const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('[inert],[hidden]') && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; };
  return [...document.querySelectorAll('button:not([disabled]),[role=button],[role=tab],.chip,#list .item,#tabbar button,input[type=checkbox],select')].filter(vis).map((e) => { const t = e.matches('input[type=checkbox]') && e.closest('label') ? e.closest('label') : e, r = t.getBoundingClientRect();
    return [(e.id ? '#' + e.id : e.tagName.toLowerCase()) + '.' + String(e.className).split(' ')[0], Math.round(r.width), Math.round(r.height)]; }).filter((x) => x[1] < 44 || x[2] < 44); })()`;

test('phone: every touch target is at least 44 x 44, in the editor, the drawer and the reading view', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'Home.md': '# Home\n#idea [[Two]]\n- [ ] task', 'Two.md': 'two #idea' }, size: [390, 844], mobile: true });
  try {
    const { ev, until } = s;
    assert.equal(await ev("document.documentElement.classList.contains('touch')"), true, 'the app sees a touch device');
    await ev("open('Home', false)"); await until("cur === 'Home'", 'open'); await ev("openInNewTab('Two', false)"); await s.sleep(400);
    assert.deepEqual(await ev(SMALL), [], 'editor view with two tabs');
    await ev("document.body.classList.add('side-open')"); await s.sleep(300); assert.deepEqual(await ev(SMALL), [], 'the notes drawer');
    await ev("document.body.classList.remove('side-open'); preview = true; renderPane()"); await s.sleep(300); assert.deepEqual(await ev(SMALL), [], 'the reading view');
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});

test('tablet: the on-screen keyboard shrinks the app, as on a phone', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'Home.md': 'x' }, size: [820, 1180], mobile: true });
  try {
    const { ev } = s;
    const h = () => ev("Math.round(document.querySelector('#app').getBoundingClientRect().height)"), full = await h(); assert.ok(full > 1000, 'full height: ' + full);
    await ev("document.documentElement.style.setProperty('--kb', '300px')"); await s.sleep(500);
    assert.equal(await h(), full - 300, 'the app leaves room for a 300px keyboard even at tablet width');
    await ev("document.documentElement.style.setProperty('--kb', '0px')"); await s.sleep(500); assert.equal(await h(), full);
  } finally { s.close(); }
});

test('phone: pull-to-refresh shows itself and refreshes; a tap enters edit mode, a drag over the text does not', { skip: !CHROME && 'Chrome not found', timeout: 90000 }, async () => {
  const s = await session({ files: { 'Home.md': '# Home\n\nSome paragraph text to tap on.', 'Two.md': 'two' }, size: [390, 844], mobile: true });
  try {
    const { ev, until } = s;
    // Real touch sequences are dispatched as TouchEvents in the page: the DevTools touch simulator hands a drag to the browser's scroller and the page never sees the rest of it.
    await ev(`window.__touch = (sel, type, x, y) => { const el = document.querySelector(sel), t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y }), end = type === 'touchend';
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: end ? [] : [t], targetTouches: end ? [] : [t], changedTouches: [t] })); }`);
    const touch = (sel, type, x, y) => ev(`window.__touch(${JSON.stringify(sel)}, ${JSON.stringify(type)}, ${x}, ${y})`);
    await ev("window.__loads = 0; const f = window.fetch; window.fetch = (u, o) => { if (/\\/api\\/notes\\?meta=1/.test(String(u))) window.__loads++; return f(u, o); }");
    await ev("document.body.classList.add('side-open')"); await s.sleep(400);
    const row = '#list .item'; const pull = async (to) => { await touch(row, 'touchstart', 120, 200); await touch(row, 'touchmove', 120, 230); await touch(row, 'touchmove', 120, to); };
    // a short pull: the indicator appears and says to keep pulling; releasing does nothing
    await pull(260); assert.equal(await ev("document.querySelector('#ptr').textContent"), 'Pull to refresh'); assert.ok(Number.parseFloat(await ev("document.querySelector('#ptr').style.height")) > 0, 'it follows the finger');
    await touch(row, 'touchend', 120, 260); assert.equal(await ev("document.querySelector('#ptr').style.height"), '0px', 'and goes away'); assert.equal(await ev('window.__loads'), 0);
    // a long pull says so, and releasing refreshes
    await pull(340); assert.equal(await ev("document.querySelector('#ptr').textContent"), 'Release to refresh'); await touch(row, 'touchend', 120, 340);
    await until('window.__loads >= 1', 'refreshed'); await until("document.querySelector('#ptr').style.height === '0px'", 'indicator closes');
    assert.equal(await ev("getComputedStyle(document.querySelector('#list')).overscrollBehaviorY"), 'contain', 'the browser\'s own pull-to-refresh is off');
    // a pull that starts in the middle of a scrolled list is just scrolling
    await ev("document.querySelector('#list').scrollTop = 0"); await ev("Object.defineProperty(document.querySelector('#list'), 'scrollTop', { configurable: true, get: () => 120, set: () => {} })");
    await touch(row, 'touchstart', 120, 200); await touch(row, 'touchmove', 120, 300); assert.equal(await ev("document.querySelector('#ptr').style.height"), '0px', 'no indicator unless the list is at the top'); await touch(row, 'touchend', 120, 300); await ev("delete document.querySelector('#list').scrollTop");
    // reading view: a tap on the text enters edit mode…
    await ev("document.body.classList.remove('side-open'); open('Home', false)"); await until("cur === 'Home'", 'open'); await ev("preview = true; renderPane()"); await until("!!document.querySelector('#pv p')", 'reading view');
    await touch('#pane', 'touchstart', 100, 300); await touch('#pane', 'touchend', 100, 300); await ev("document.querySelector('#pv p').click()"); await until("!!document.querySelector('#ed')", 'a tap starts editing');
    // …but a click that follows a drag (a scroll or a text selection that ended over the text) does not
    await ev("preview = true; renderPane()"); await until("!!document.querySelector('#pv p')", 'reading view again');
    await touch('#pane', 'touchstart', 100, 400); await touch('#pane', 'touchmove', 100, 360); await touch('#pane', 'touchmove', 100, 300); await touch('#pane', 'touchend', 100, 300); await ev("document.querySelector('#pv p').click()"); await s.sleep(200);
    assert.equal(await ev("!!document.querySelector('#ed')"), false, 'still reading'); await ev("document.querySelector('#pv p').click()"); await until("!!document.querySelector('#ed')", 'the next real tap works again');
    assert.deepEqual(s.errors, []);
  } finally { s.close(); }
});
