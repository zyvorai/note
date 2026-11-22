#!/usr/bin/env node
// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Measures how the app feels on a big vault: generates N notes, loads the UI in headless Chrome and times the operations people wait for.
//   node scripts/bench-ux.js [--notes 10000] [--repo /path/to/another/checkout]     (--repo benchmarks an older checkout against the same vault generator)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { session, CHROME } = require('../tests/helpers/session');

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(arg('--notes', 10000)), repo = arg('--repo', null);
if (!CHROME) { console.error('Chrome not found'); process.exit(1); }

let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;   // deterministic, so runs are comparable
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa officia deserunt mollit anim id est laborum'.split(' ');
const sentence = () => Array.from({ length: 8 + Math.floor(rnd() * 12) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ') + '. ';
function makeVault(dir) {
  const names = Array.from({ length: N }, (_, i) => `f${i % 50}/Note ${i}`);
  names.forEach((name, i) => {
    const links = [0, 1, 2].map(() => `[[${names[Math.floor(rnd() * N)].split('/').pop()}]]`), tags = [0, 1].map(() => '#tag' + Math.floor(rnd() * 40));
    const fm = i % 10 === 0 ? `---\naliases: [Alias ${i}]\n---\n` : '';
    const text = `${fm}# Note ${i}\n\n` + Array.from({ length: 12 + Math.floor(rnd() * 12) }, sentence).join('') + `\n\nSee ${links.join(', ')} ${tags.join(' ')}\n\n- [ ] a task ${i}\n`;
    fs.mkdirSync(path.dirname(path.join(dir, name + '.md')), { recursive: true }); fs.writeFileSync(path.join(dir, name + '.md'), text);
  });
  return names;
}

(async () => {
  const t0 = Date.now(); const s = await session({ repo, files: {} });
  try {
    makeVault(s.dir); console.log(`vault: ${N} notes generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const { ev } = s;
    await s.reload(); await new Promise((r) => setTimeout(r, 500));
    const time = (expr, runs = 1) => ev(`(async () => { const t = []; for (let i = 0; i < ${runs}; i++) { const a = performance.now(); await (${expr}); t.push(performance.now() - a); } t.sort((x, y) => x - y); return { ms: Math.round(t[Math.floor(t.length / 2)] * 10) / 10 }; })()`).then((r) => r.ms);
    const bytes = () => ev("performance.getEntriesByType('resource').filter((e) => /\\/api\\/notes/.test(e.name)).reduce((a, e) => a + e.encodedBodySize, 0)");
    const out = {};
    await ev("performance.setResourceTimingBufferSize(5000); performance.clearResourceTimings()");
    out['cold load (first, every note)'] = await time('(async () => { notes = new Map(); await load(); })()'); out['  transferred (bytes)'] = await bytes();
    await ev("performance.clearResourceTimings()");
    out['reload when nothing changed (window focus)'] = await time('load()', 3); out['  transferred (bytes)'] = await bytes();
    out['search: one keystroke -> list (renderList)'] = await time("(async () => { document.querySelector('#q').value = 'lorem ipsum'; renderList(); })()", 5);
    out['search: tag filter -> list'] = await time("(async () => { document.querySelector('#q').value = ''; activeTag = 'tag7'; renderList(); activeTag = null; })()", 5);
    out['tags panel (renderTags)'] = await time('renderTags()', 5);
    out['note list, no query (renderList)'] = await time("(async () => { document.querySelector('#q').value = ''; renderList(); })()", 5);
    out['open a note (incl. backlinks)'] = await time("open('f3/Note 3', false)", 5);
    out['backlinks panel (renderBack)'] = await time('renderBack()', 5);
    out['global find: one keystroke'] = await time("(async () => { openGlobalFind(); document.querySelector('#gfq').value = 'dolor sit'; gfRender(); closeGlobalFind(); })()", 3);
    out['graph: 20 simulation steps'] = await ev("(async () => { graphOn = true; renderPane(); await new Promise((r) => setTimeout(r, 400)); const a = performance.now(); await new Promise((r) => { let f = 0; const loop = () => { if (++f >= 20) return r(); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }); const ms = (performance.now() - a) / 20; graphOn = false; renderPane(); return Math.round(ms * 10) / 10; })()");
    console.log(`\n${repo ? 'checkout: ' + repo : 'this checkout'}   (median ms unless noted)`); for (const [k, v] of Object.entries(out)) console.log(String(v).padStart(10), ' ', k);
    fs.writeFileSync(arg('--json', path.join(os.tmpdir(), 'bench-ux-last.json')), JSON.stringify({ notes: N, repo: repo || 'this', results: out }, null, 2));
  } finally { s.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
