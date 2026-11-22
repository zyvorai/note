'use strict';
// PDF editing: node server.js pdf <merge|extract|delete|rotate|stamp|info> ...
// Optional add-on: needs `npm install pdf-lib` (loaded only here, so the app itself still has zero dependencies).
const fs = require('fs'), path = require('path');

function lib() {
  try { return require('pdf-lib'); }
  catch { throw new Error('PDF editing needs the optional pdf-lib package. Run: npm install pdf-lib --no-save'); }
}
const load = (f) => lib().PDFDocument.load(fs.readFileSync(f));
// "1,3-5,8" -> zero-based page indexes, validated against the page count
function pages(spec, n) {
  const out = [];
  for (const part of String(spec || '').split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad page range "${part}" (use e.g. 1,3-5)`);
    const a = +m[1], b = +(m[2] || m[1]);
    if (a < 1 || b < a || b > n) throw new Error(`page range ${part} is outside 1-${n}`);
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  return out;
}
const save = async (doc, out) => { fs.writeFileSync(out, await doc.save()); return out; };

async function run(args) {
  const [cmd, ...a] = args;
  const { PDFDocument, degrees, StandardFonts, rgb } = lib();
  switch (cmd) {
    case 'info': { const d = await load(a[0]); return `${a[0]}: ${d.getPageCount()} pages`; }
    case 'merge': {                         // merge out.pdf a.pdf b.pdf ...
      const [out, ...ins] = a; if (!out || ins.length < 2) throw new Error('usage: pdf merge <out.pdf> <a.pdf> <b.pdf> …');
      const d = await PDFDocument.create();
      for (const f of ins) { const s = await load(f); (await d.copyPages(s, s.getPageIndices())).forEach((p) => d.addPage(p)); }
      return save(d, out);
    }
    case 'extract': case 'delete': {        // extract in.pdf 1,3-5 out.pdf   |   delete in.pdf 2 out.pdf
      const [inp, spec, out] = a; if (!inp || !spec || !out) throw new Error(`usage: pdf ${cmd} <in.pdf> <pages> <out.pdf>`);
      const s = await load(inp), n = s.getPageCount(), sel = pages(spec, n);
      const keep = cmd === 'extract' ? sel : s.getPageIndices().filter((i) => !sel.includes(i));
      if (!keep.length) throw new Error('that would leave no pages');
      const d = await PDFDocument.create(); (await d.copyPages(s, keep)).forEach((p) => d.addPage(p));
      return save(d, out);
    }
    case 'rotate': {                        // rotate in.pdf 90 out.pdf [pages]
      const [inp, deg, out, spec] = a; const r = Number(deg);
      if (!inp || !out || ![90, 180, 270, -90].includes(r)) throw new Error('usage: pdf rotate <in.pdf> <90|180|270|-90> <out.pdf> [pages]');
      const d = await load(inp), all = d.getPages();
      for (const i of spec ? pages(spec, all.length) : all.keys()) all[i].setRotation(degrees((all[i].getRotation().angle + r + 360) % 360));
      return save(d, out);
    }
    case 'stamp': {                         // stamp in.pdf "DRAFT" out.pdf [pages]  — diagonal watermark text
      const [inp, text, out, spec] = a; if (!inp || !text || !out) throw new Error('usage: pdf stamp <in.pdf> <text> <out.pdf> [pages]');
      const d = await load(inp), font = await d.embedFont(StandardFonts.HelveticaBold), all = d.getPages();
      for (const i of spec ? pages(spec, all.length) : all.keys()) {
        const { width, height } = all[i].getSize(), size = Math.min(width, height) / 6;
        all[i].drawText(text, { x: width * 0.15, y: height * 0.3, size, font, color: rgb(0.8, 0.1, 0.1), opacity: 0.25, rotate: degrees(40) });
      }
      return save(d, out);
    }
    default: throw new Error('usage: node server.js pdf <info|merge|extract|delete|rotate|stamp> …');
  }
}
module.exports = { run, pages };
