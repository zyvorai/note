// Import notes from other apps into plain Markdown: Obsidian vaults, Notion exports (Markdown & CSV, or HTML), Bear / Markdown folders,
// Textbundles, Evernote .enex, and any .zip of those. No dependencies; runs in the browser (the in-app importer) and in Node (the CLI).
//   const files = await PNImport.prepare([{ path, data: Uint8Array }, ...]);       // expands zips
//   const plan = PNImport.plan(files, { existing: Set(lowercase names), prefix: 'Imported', html2md });
//   const notes = PNImport.finalize(plan, uploaded /* Map: attachment .from -> saved path */);   // [{ name, text }]
(function (root) {
  'use strict';
  const ATTACH = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };
  const TEXT = new Set(['md', 'markdown', 'txt']);
  const LIMITS = { entry: 100e6, total: 600e6, entries: 100000 };
  const ext = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
  const base = (p) => p.slice(p.lastIndexOf('/') + 1);
  const utf8 = (u8) => new TextDecoder('utf-8').decode(u8);
  const NOTION_ID = /\s+[0-9a-f]{32}$/i;

  // ---------- zip ----------
  async function inflateRaw(u8, cap) {
    const ds = new DecompressionStream('deflate-raw'), w = ds.writable.getWriter();
    w.write(u8).catch(() => {}); w.close().catch(() => {});
    const r = ds.readable.getReader(), chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await r.read(); if (done) break;
      n += value.length; if (n > cap) { await r.cancel().catch(() => {}); throw new Error('a file inside the zip is too large'); }
      chunks.push(value);
    }
    const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  async function readZip(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('This does not look like a zip file');
    const count = dv.getUint16(e + 10, true), cdOff = dv.getUint32(e + 16, true);
    if (count === 0xffff || cdOff === 0xffffffff) throw new Error('This zip is too large (zip64). Unzip it and choose the folder instead.');
    if (count > LIMITS.entries) throw new Error('This zip has too many files');
    const out = []; let p = cdOff, total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('The zip is damaged');
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = utf8(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + el + cl;
      if (name.endsWith('/')) continue;
      if (flags & 1) throw new Error('Password-protected zips are not supported');
      if (usize > LIMITS.entry || (total += usize) > LIMITS.total) throw new Error('This zip is too large to import in one go; import it in parts');
      if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('The zip is damaged');
      const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), raw = u8.subarray(ds, ds + csize);
      let data;
      if (method === 0) data = raw.slice(); else if (method === 8) data = await inflateRaw(raw, Math.min(LIMITS.entry, usize + 1024)); else { out.push({ path: name, skipped: 'unsupported compression' }); continue; }
      out.push({ path: name, data });
    }
    return out;
  }
  // Paths from archives and folders are untrusted: normalise, drop hidden/system entries and anything that climbs out with "..".
  function cleanPath(p) {
    const segs = String(p).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
    if (!segs.length || segs.some((s) => s === '..' || /^[A-Za-z]:$/.test(s))) return null;
    if (segs.some((s) => s.startsWith('.') || s === '__MACOSX' || s === 'node_modules')) return '';
    return segs.join('/');
  }
  async function prepare(raw, depth = 0) {
    const out = [], warnings = [];
    for (const f of raw) {
      if (!f.data) continue;
      const p = cleanPath(f.path);
      if (p === null) { warnings.push(`Skipped an unsafe path: ${f.path}`); continue; }
      if (p === '') continue;
      if (ext(p) === 'zip' && depth < 2) {
        try { const inner = await prepare(await readZip(f.data), depth + 1); out.push(...inner.files); warnings.push(...inner.warnings); }
        catch (e) { warnings.push(`${p}: ${e.message}`); }
      } else out.push({ path: p, data: f.data });
    }
    // a single wrapping folder (the vault or export name) is not part of the note names
    const tops = new Set(out.map((f) => f.path.split('/')[0]));
    if (depth === 0 && tops.size === 1 && out.every((f) => f.path.includes('/'))) for (const f of out) f.path = f.path.slice(f.path.indexOf('/') + 1);
    return { files: out, warnings };
  }

  // ---------- helpers ----------
  const seg = (s) => s.replace(NOTION_ID, '').replace(/[\\:*?"<>|#^\[\]]+/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 120) || 'Untitled';
  function noteName(path) {
    const parts = path.split('/'); let last = parts.pop().replace(/\.[^.]+$/, '');
    if (/^text$/i.test(last) && parts.length && /\.textbundle$/i.test(parts[parts.length - 1])) last = parts.pop().replace(/\.textbundle$/i, '');
    return [...parts.map((p) => seg(p.replace(/\.textbundle$/i, ''))), seg(last)].join('/');
  }
  function csvRows(text) {                                           // RFC 4180: quotes, doubled quotes, newlines inside quotes
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }
  const csvToMd = (title, text) => {
    const rows = csvRows(text.replace(/^﻿/, '')); if (!rows.length) return '';
    const w = Math.max(...rows.map((r) => r.length)), line = (r) => `| ${Array.from({ length: w }, (_, k) => (r[k] || '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|').trim()).join(' | ')} |`;
    return `# ${title}\n\n${[line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n')}\n`;
  };
  function md5(u8) {                                                  // RFC 1321, for matching Evernote <en-media hash="…"> to its resource
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const len = u8.length, buf = new Uint8Array((((len + 8) >>> 6) + 1) * 64); buf.set(u8); buf[len] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(buf.length - 8, (len << 3) >>> 0, true); dv.setUint32(buf.length - 4, Math.floor(len / 0x20000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < buf.length; off += 64) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + dv.getUint32(off + g * 4, true)) >>> 0;
        A = D; D = C; C = B; const s = S[(i >> 4) * 4 + (i % 4)];
        B = (B + (((F << s) | (F >>> (32 - s))) >>> 0)) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const o = new Uint8Array(16), ov = new DataView(o.buffer); [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
    return [...o].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const b64 = (s) => { const bin = atob(s.replace(/\s+/g, '')), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const enDate = (s) => (/^(\d{4})(\d\d)(\d\d)/.exec(s || '') || []).slice(1, 4).join('-');

  // Evernote .enex: one XML file holding many notes. ENML is HTML-like, so it goes through the shared HTML -> Markdown converter.
  function expandEnex(path, data, html2md, add) {
    const doc = new DOMParser().parseFromString(utf8(data), 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('not a valid .enex file');
    const book = seg(base(path).replace(/\.enex$/i, '')); let n = 0;
    for (const note of doc.querySelectorAll('note')) {
      const q = (sel, el = note) => { const x = el.querySelector(sel); return x ? x.textContent : ''; };
      const title = q(':scope > title') || 'Untitled', res = new Map();
      for (const r of note.querySelectorAll(':scope > resource')) {
        const d = r.querySelector('data'); if (!d) continue;
        let bytes; try { bytes = b64(d.textContent); } catch { continue; }
        const mime = q('mime', r), fn = q('file-name', r), hash = md5(bytes), e = Object.keys(ATTACH).find((k) => ATTACH[k] === mime) || ext(fn);
        res.set(hash, { hash, mime, name: fn || `${hash}.${e}`, ext: e, bytes });
      }
      const dom = new DOMParser().parseFromString(`<body>${q(':scope > content').replace(/^[\s\S]*?<en-note[^>]*>/i, '').replace(/<\/en-note>[\s\S]*$/i, '')}</body>`, 'text/html');
      for (const m of dom.querySelectorAll('en-media')) {
        const h = (m.getAttribute('hash') || '').toLowerCase(), r = res.get(h);
        const el = dom.createElement(r && r.mime.startsWith('image/') ? 'img' : 'a');
        if (el.nodeName === 'IMG') { el.setAttribute('src', 'enres:' + h); el.setAttribute('alt', r.name.replace(/\.\w+$/, '')); } else { el.setAttribute('href', 'enres:' + h); el.textContent = r ? r.name : 'attachment'; }
        m.replaceWith(el, ...m.childNodes);                            // an HTML parser does not honour `<en-media/>`: what follows becomes its children, so keep it
      }
      for (const t of dom.querySelectorAll('en-todo')) t.replaceWith(dom.createTextNode(t.getAttribute('checked') === 'true' ? '[x] ' : '[ ] '), ...t.childNodes);
      let md = html2md(dom.body.innerHTML, 'https://import.invalid/', true, { enres: true }).replace(/^\[([ x])\] /gm, '- [$1] ');
      const tags = [...note.querySelectorAll(':scope > tag')].map((t) => t.textContent.trim().replace(/\s+/g, '-')).filter(Boolean);
      const fm = ['---', enDate(q(':scope > created')) && `created: ${enDate(q(':scope > created'))}`, enDate(q(':scope > updated')) && `updated: ${enDate(q(':scope > updated'))}`, tags.length && `tags: ${tags.join(' ')}`, '---'].filter(Boolean);
      add({ from: `${path}#${++n}`, name: `${book}/${seg(title)}`, text: (fm.length > 2 ? fm.join('\n') + '\n\n' : '') + (/^#\s/.test(md) ? md : `# ${title}\n\n${md}`) + '\n', dir: '' });
      for (const r of res.values()) if (ATTACH[r.ext]) add({ attachment: { from: 'enres:' + r.hash, name: r.name, data: r.bytes, ext: r.ext } });
    }
  }

  // ---------- plan ----------
  function plan(files, opts = {}) {
    const existing = new Set([...(opts.existing || [])].map((x) => x.toLowerCase())), prefix = (opts.prefix || '').replace(/^\/+|\/+$/g, '');
    const out = { notes: [], attachments: [], warnings: [], stats: { notes: 0, attachments: 0, links: 0, csv: 0, html: 0, enex: 0, skipped: {} } };
    const notion = files.some((f) => f.path.split('/').some((s) => NOTION_ID.test(s.replace(/\.[^.]+$/, ''))));
    const attSeen = new Map(), used = new Set(existing), notes = [];
    const unique = (name) => { let n = name, i = 1; while (used.has(n.toLowerCase())) n = `${name} ${++i}`; used.add(n.toLowerCase()); return n; };
    const addAtt = (a) => { if (!attSeen.has(a.from.toLowerCase())) { attSeen.set(a.from.toLowerCase(), a); out.attachments.push(a); } };
    const skip = (e) => { out.stats.skipped[e || '(none)'] = (out.stats.skipped[e || '(none)'] || 0) + 1; };
    for (const f of files) {
      const e = ext(f.path), dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (TEXT.has(e)) notes.push({ from: f.path, name: noteName(f.path), text: utf8(f.data), dir });
      else if (e === 'csv' && /_all\.csv$/i.test(f.path) && notion) { /* Notion writes every database twice; the plain copy is imported */ }
      else if (e === 'csv' && notion) { const t = csvToMd(seg(base(f.path).replace(/\.csv$/i, '')), utf8(f.data)); if (t) { notes.push({ from: f.path, name: noteName(f.path), text: t, dir }); out.stats.csv++; } }
      else if ((e === 'html' || e === 'htm') && opts.html2md) { notes.push({ from: f.path, name: noteName(f.path), text: opts.html2md(utf8(f.data), 'https://import.invalid/' + encodeURI(f.path), true) + '\n', dir }); out.stats.html++; }
      else if (e === 'enex' && opts.html2md && typeof DOMParser !== 'undefined') {
        try { expandEnex(f.path, f.data, opts.html2md, (x) => (x.attachment ? addAtt(x.attachment) : notes.push(x))); out.stats.enex++; }
        catch (err) { out.warnings.push(`${f.path}: ${err.message}`); }
      } else if (ATTACH[e]) addAtt({ from: f.path, name: base(f.path), data: f.data, ext: e });
      else if (e === 'enex' || e === 'html' || e === 'htm') out.warnings.push(`${f.path}: this format needs the in-app importer (File → command palette → Import notes)`);
      else skip(e);
    }
    // final names: folders kept, Notion ids and illegal characters removed, clashes numbered, optional prefix
    const byPath = new Map();
    for (const n of notes) {
      n.name = unique(prefix ? `${prefix}/${n.name}` : n.name);
      const k = n.from.toLowerCase(); byPath.set(k, n); byPath.set(k.replace(/\.[^./]+$/, ''), n);
      const nm = n.name.toLowerCase(); n.keyName = nm;
    }
    out.notes = notes; out.byPath = byPath; out.attByPath = attSeen;
    out.attByBase = new Map(); for (const a of out.attachments) { const k = base(a.from).toLowerCase(); if (!out.attByBase.has(k)) out.attByBase.set(k, a); }
    out.stats.notes = notes.length; out.stats.attachments = out.attachments.length;
    const sk = Object.entries(out.stats.skipped); if (sk.length) out.warnings.push(`Skipped ${sk.reduce((t, [, c]) => t + c, 0)} unsupported file(s): ${sk.map(([e, c]) => `.${e} × ${c}`).join(', ')}`);
    return out;
  }

  // ---------- finalize: rewrite links so they point at the imported names and the saved attachment paths ----------
  function resolvePath(dir, target) {
    let t = target.replace(/^https:\/\/import\.invalid\//, '/'); try { t = decodeURIComponent(t); } catch {}
    t = t.replace(/[#?].*$/, '');
    const segs = t.startsWith('/') ? [] : dir ? dir.split('/') : [];
    for (const s of t.split('/')) { if (!s || s === '.') continue; if (s === '..') segs.pop(); else segs.push(s); }
    return segs.join('/').toLowerCase();
  }
  function finalize(p, uploaded) {
    const attPath = (a) => (a && uploaded.get(a.from)) || null;
    const lookupAtt = (dir, target) => p.attByPath.get(resolvePath(dir, target)) || null;
    let links = 0;
    const fixPart = (s, dir) => {
      s = s.replace(/(!?)\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (m, bang, text, target) => {
        if (/^enres:/i.test(target)) { const a = p.attByPath.get(target.toLowerCase()), np = attPath(a); if (!np) return bang ? '' : text; links++; return bang ? `![${text}](${np})` : `[${text}](${np})`; }
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https:\/\/import\.invalid\//.test(target)) return m;       // external
        if (/^#/.test(target)) return m;
        const a = lookupAtt(dir, target);
        if (a) { const np = attPath(a); if (!np) return m; links++; return bang ? `![${text}](${np})` : `[${text || a.name}](${np})`; }
        if (!bang) { const n = p.byPath.get(resolvePath(dir, target)); if (n) { links++; const lbl = text && text !== base(n.name) ? `|${text.replace(/[\]|]/g, ' ')}` : ''; return `[[${n.name}${lbl}]]`; } }
        return m;
      });
      s = s.replace(/(!?)\[\[([^\]|#\n]+?)(#[^\]|]*)?(?:\|([^\]\n]*))?\]\]/g, (m, bang, target, frag, alias) => {
        const t = target.trim(), e = ext(t);
        if (ATTACH[e]) { const a = p.attByPath.get(resolvePath('', t)) || p.attByBase.get(base(t).toLowerCase()), np = attPath(a); if (!np) return m; links++; return bang ? `![${alias || ''}](${np})` : `[${alias || base(t)}](${np})`; }
        if (!bang && t.includes('/')) { const n = p.byPath.get(resolvePath('', t)); if (n) { links++; return `[[${n.name}${frag || ''}${alias ? '|' + alias : ''}]]`; } }
        return m;
      });
      return s;
    };
    const fixText = (text, dir) => {
      let fence = false;
      return text.split('\n').map((line) => {
        if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return line; }
        return fence ? line : line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : fixPart(part, dir))).join('');
      }).join('\n');
    };
    const res = p.notes.map((n) => ({ name: n.name, text: fixText(n.text, n.dir) }));
    p.stats.links = links; return res;
  }

  const api = { readZip, prepare, plan, finalize, md5, csvRows, csvToMd, noteName, cleanPath, ATTACH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PNImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
