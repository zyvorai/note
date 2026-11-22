'use strict';
// Publish notes as a static website (plain HTML + one stylesheet), e.g. for GitHub Pages.
//   node server.js publish <notesDir> <outDir> [--title "My notes"]
// A note with `publish: false` in its frontmatter is skipped, and links to it become plain text.
const fs = require('fs'), path = require('path');
const MD = require('../public/md.js');

const ATTACH = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);
const esc = MD.esc;
const CSS = `:root{--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--line:#e5e5ea;--acc:#5b5bd6;--code:#f0f0f3;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#1e1e1e;--fg:#ececf0;--mute:#9a9aa3;--line:#2c2c32;--acc:#9d9dff;--code:#26262c}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 -apple-system,system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1.2rem 4rem}nav{font-size:14px;color:var(--mute);margin-bottom:1.5rem}
a{color:var(--acc)}a.new{color:var(--mute)}img,svg{max-width:100%;height:auto}.pdfembed{width:100%;height:70vh}
pre,code{background:var(--code);border-radius:6px}code{padding:.1em .35em}pre{padding:12px;overflow:auto}pre code{padding:0}
blockquote{border-left:3px solid var(--line);margin:0;padding:0 1em;color:var(--mute)}table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:4px 10px}
h1,h2{border-bottom:1px solid var(--line);padding-bottom:.25em}.tag{color:var(--mute);text-decoration:none}li.nt{list-style:none}
math{font-size:1.08em}.math-block{margin:1em 0;overflow-x:auto;text-align:center}.mathbad{color:#c0392b}
footer{margin-top:3rem;color:var(--mute);font-size:13px}`;

function* walk(dir, base = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(path.join(dir, e.name), rel);
    else if (e.isFile() && /\.md$/i.test(e.name)) yield rel.replace(/\.md$/i, '');
  }
}
const isPrivate = (text) => /^---\r?\n[\s\S]*?^publish:\s*(false|no)\s*$[\s\S]*?^---/mi.test(text);
const titleOf = (name, body) => (body.match(/^#\s+(.+)$/m) || [])[1] || name.split('/').pop();

function build(root, out, opts = {}) {
  root = path.resolve(root); out = path.resolve(out);
  if (out === root || root.startsWith(out + path.sep)) throw new Error('The output folder must not contain or equal the notes folder');
  const inside = path.relative(root, out);
  if (!inside.startsWith('..') && !inside.split(path.sep).some((x) => x.startsWith('.'))) throw new Error('Inside the notes folder, publish to a dot-folder (e.g. .plainnote/site) so notes are never overwritten');
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, '.plainnote-site'))) throw new Error(`${out} is not empty and was not made by publish; choose a new or empty folder`);
  const site = opts.title || 'Notes', notes = new Map(), skipped = [];
  for (const name of walk(root)) {
    const text = fs.readFileSync(path.join(root, name + '.md'), 'utf8');
    if (isPrivate(text)) skipped.push(name); else notes.set(name, { name, text, body: MD.frontmatter(text).body });
  }
  const lower = new Map([...notes.keys()].map((n) => [n.toLowerCase(), n]));
  const resolve = (t) => { const k = t.split(/[#^|]/)[0].trim().toLowerCase(); return lower.get(k) || [...lower].find(([l]) => l.split('/').pop() === k)?.[1] || null; };
  const { md } = MD.create({ resolve, embed: (name, h) => { const n = notes.get(name); return n ? (h ? MD.section(n.body, h) : n.body) : null; } });

  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'style.css'), CSS);
  const copied = new Set();
  const page = (title, rel, body, crumb) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(site)}</title><link rel="stylesheet" href="${rel}style.css"></head><body><main><nav>${crumb}</nav>${body}<footer>Published with Plainnote</footer></main></body></html>\n`;

  for (const n of notes.values()) {
    const rel = '../'.repeat(n.name.split('/').length - 1), dest = path.join(out, n.name + '.html');
    let html = md(n.body);
    html = html.replace(/<a href="#" data-note="([^"]*)"([^>]*?) class="(new)?">/g, (_, t, extra, nw) => {
      const r = resolve(t.replace(/&amp;/g, '&')); const a = (extra.match(/data-anchor="([^"]*)"/) || [])[1];
      return r ? `<a href="${rel}${encodeURI(r)}.html${a ? '#' + encodeURIComponent(a) : ''}">` : '<a class="new">';
    }).replace(/<a href="#" class="tag" data-tag="[^"]*">/g, '<a class="tag">')
      .replace(/(src|href)="\/files\/([^"]+)"/g, (_, attr, p) => {
        let f; try { f = decodeURIComponent(p); } catch { return _; }
        const src = path.resolve(root, f);
        if (src.startsWith(root + path.sep) && ATTACH.has(path.extname(f).toLowerCase()) && fs.existsSync(src)) {
          if (!copied.has(f)) { fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true }); fs.copyFileSync(src, path.join(out, f)); copied.add(f); }
          return `${attr}="${rel}${p}"`;
        }
        return `${attr}="#"`;
      });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, page(titleOf(n.name, n.body), rel, html, `<a href="${rel}index.html">${esc(site)}</a>`));
  }
  const rows = [...notes.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => `<li><a href="${encodeURI(n.name)}.html">${esc(titleOf(n.name, n.body))}</a>${n.name.includes('/') ? ` <small>${esc(n.name.split('/').slice(0, -1).join(' / '))}</small>` : ''}</li>`).join('\n');
  fs.writeFileSync(path.join(out, 'index.html'), page(site, '', `<h1>${esc(site)}</h1><ul>${rows}</ul>`, ''));
  fs.writeFileSync(path.join(out, '.nojekyll'), ''); fs.writeFileSync(path.join(out, '.plainnote-site'), '');
  return { out, pages: notes.size, attachments: copied.size, skipped };
}

async function run(args) {
  const pos = [], o = {};
  for (let i = 0; i < args.length; i++) { if (args[i] === '--title') o.title = args[++i]; else pos.push(args[i]); }
  if (pos.length < 2) throw new Error('usage: node server.js publish <notesDir> <outDir> [--title "My notes"]');
  const r = build(pos[0], pos[1], o);
  return `Published ${r.pages} note${r.pages === 1 ? '' : 's'} and ${r.attachments} attachment${r.attachments === 1 ? '' : 's'} to ${r.out}` + (r.skipped.length ? `\nSkipped (publish: false): ${r.skipped.join(', ')}` : '');
}
module.exports = { build, run };
