'use strict';
// Import a folder or .zip of Markdown (Obsidian, Notion "Markdown & CSV", Bear, plain .md) into your notes folder.
//   node server.js import <source> [notesDir] [--into Imported | --merge]
// Evernote (.enex) and HTML exports need the in-app importer (command palette: "Import notes from another app").
const fs = require('fs'), path = require('path');
const PNImport = require('../public/import.js');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') yield* walk(full); } else if (e.isFile()) yield full;
  }
}
const existingNames = (root) => { const s = new Set(); if (fs.existsSync(root)) for (const f of walk(root)) if (/\.md$/i.test(f)) s.add(path.relative(root, f).split(path.sep).join('/').replace(/\.md$/i, '').toLowerCase()); return s; };

async function run(args) {
  const pos = []; let into = 'Imported';
  for (let i = 0; i < args.length; i++) { if (args[i] === '--into') into = args[++i] || ''; else if (args[i] === '--merge') into = ''; else pos.push(args[i]); }
  const [source, dest] = pos;
  if (!source) throw new Error('usage: node server.js import <folder-or-zip> [notesDir] [--into Imported | --merge]');
  const root = path.resolve(dest || path.join(__dirname, '..', 'notes')), src = path.resolve(source);
  if (!fs.existsSync(src)) throw new Error(`${src} does not exist`);
  if (src === root || root.startsWith(src + path.sep) || src.startsWith(root + path.sep)) throw new Error('The source and the notes folder must be separate folders');
  const raw = fs.statSync(src).isDirectory() ? [...walk(src)].map((f) => ({ path: path.relative(src, f), data: new Uint8Array(fs.readFileSync(f)) })) : [{ path: path.basename(src), data: new Uint8Array(fs.readFileSync(src)) }];
  const prepared = await PNImport.prepare(raw);
  const plan = PNImport.plan(prepared.files, { existing: existingNames(root), prefix: into });
  const uploaded = new Map(); let n = 0;
  fs.mkdirSync(path.join(root, 'attachments'), { recursive: true });
  for (const a of plan.attachments) {
    const rel = `attachments/${Date.now()}-${++n}-${a.name.replace(/[^\w.-]+/g, '-').slice(0, 60)}`;
    fs.writeFileSync(path.join(root, rel), a.data); uploaded.set(a.from, rel);
  }
  let written = 0;
  for (const note of PNImport.finalize(plan, uploaded)) {
    const file = path.resolve(root, note.name + '.md');
    if (!file.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, note.text, { flag: 'wx' }); written++; } catch (e) { if (e.code !== 'EEXIST') throw e; plan.warnings.push(`${note.name}: already exists, skipped`); }
  }
  const warn = [...prepared.warnings, ...plan.warnings];
  return `Imported ${written} note${written === 1 ? '' : 's'}, ${plan.attachments.length} attachment${plan.attachments.length === 1 ? '' : 's'}, ${plan.stats.links} link${plan.stats.links === 1 ? '' : 's'} fixed → ${root}${into ? '/' + into : ''}` + (warn.length ? '\n' + warn.slice(0, 20).map((w) => '  ! ' + w).join('\n') + (warn.length > 20 ? `\n  … and ${warn.length - 20} more` : '') : '');
}
module.exports = { run };
