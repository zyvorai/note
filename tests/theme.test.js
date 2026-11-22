// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Colour contrast is checked from the real stylesheet, so a palette edit that breaks accessibility fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
const decls = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
const light = decls(/^:root\{([^}]*)\}/m.exec(css)[1]);
const darkAttr = decls(/^:root\[data-theme=dark\]\{([^}]*)\}/m.exec(css)[1]);
const darkMedia = decls(/@media\(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{([^}]*)\}/.exec(css)[1]);

const rgba = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]; };
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('the two dark-theme blocks are identical, so system-dark and chosen-dark never drift', () => {
  assert.deepEqual(darkMedia, darkAttr);
  for (const k of ['on-acc', 'danger', 'ok', 'warn']) assert.ok(darkAttr[k], `dark theme defines --${k}`);
  for (const k of ['danger', 'scrim', 'mark']) assert.ok(light[k], `light theme defines --${k}`);
});

for (const [name, v] of [['light', light], ['dark', { ...light, ...darkAttr }]]) {
  test(`${name} theme: text and UI colours meet WCAG contrast`, () => {
    const C = (k) => rgba(v[k]), bg = C('bg'), side = C('side'), code = C('code');
    const field = (base) => over(rgba(v.field), base);
    const AA = 4.5;
    const pairs = [
      ['body text on page', C('fg'), bg], ['body text on sidebar', C('fg'), side],
      ['muted on page', C('mute'), bg], ['muted on sidebar', C('mute'), side], ['muted on a chip (field over sidebar)', C('mute'), field(side)], ['muted on a chip (field over page)', C('mute'), field(bg)],
      ['accent text on page', C('acc'), bg], ['accent text on sidebar', C('acc'), side],
      ['text on an accent fill (selected row, primary button)', C('on-acc'), C('acc')],
      ['string colour on code background', C('str'), code], ['number colour on code background', C('num'), code],
      ['error text on page', C(`danger`), bg],
    ];
    for (const [what, fg, back] of pairs) assert.ok(ratio(fg, back) >= AA, `${name}: ${what} is ${ratio(fg, back).toFixed(2)}:1, needs ${AA}:1`);
    assert.ok(ratio(C('acc'), bg) >= 3, `${name}: accent as a UI outline (focus ring) needs 3:1`);
  });
}

test('no stray hard-coded error red or scrims are left in the stylesheet', () => {
  assert.equal((css.match(/#c0392b/gi) || []).length, 1, 'only the --danger definition keeps the literal');
  assert.equal((css.match(/background:#0006/g) || []).length, 0);
});
