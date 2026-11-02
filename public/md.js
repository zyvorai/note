// Markdown rendering and editor text helpers. Pure functions, no DOM: shared by the browser UI and the tests.
(function (root) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const linkRe = /\[\[([^\]\|\n]+?)(?:\|([^\]\n]+))?\]\]/g;
  const tagRe = /(^|[\s(])#((?=[\w\/-]*[A-Za-z_])[\w\/-]+)/g;
  // Leading `---` YAML-ish block: simple `key: value`, `key: [a, b]` and `- item` lists. -> { data, body }
  const unq = (v) => {
    v = v.trim();
    if (v.length > 1 && v[0] === '"' && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"');
    if (v.length > 1 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    return v.replace(/^["']|["']$/g, '');
  };
  const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
  // the entries of a frontmatter block, in order, with the line range each one occupies
  function fmEntries(lines) {
    const out = []; let cur = null;
    lines.forEach((line, i) => {
      const kv = line.match(/^([\w-]+):\s*(.*)$/), it = line.match(/^\s+-\s+(.*)$|^-\s+(.*)$/);
      if (kv) {
        const v = kv[2].trim();
        cur = { name: kv[1], key: kv[1].toLowerCase(), start: i, end: i + 1, block: false,
          value: v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(unq).filter(Boolean) : v ? unq(v) : [] };
        out.push(cur);
      } else if (it && cur) {
        if (!Array.isArray(cur.value)) cur.value = cur.value ? [cur.value] : [];
        cur.value.push(unq(it[1] ?? it[2])); cur.end = i + 1; cur.block = true;
      }
    });
    return out;
  }
  function frontmatter(text) {
    const m = text.match(FM);
    if (!m) return { data: {}, body: text };
    const data = {};
    for (const e of fmEntries(m[1].split(/\r?\n/))) data[e.key] = e.value;
    return { data, body: text.slice(m[0].length) };
  }
  // Properties (frontmatter) as an editable list, and writing them back without touching the rest of the file.
  function properties(text) {
    const m = text.match(FM); if (!m) return [];
    const last = new Map();
    for (const e of fmEntries(m[1].split(/\r?\n/))) last.set(e.key, e);
    return [...last.values()].map((e) => {
      const v = e.value;
      if (Array.isArray(v)) return { key: e.name, value: v, type: 'list' };
      if (/^(true|false)$/i.test(v)) return { key: e.name, value: /^true$/i.test(v), type: 'checkbox' };
      if (/^-?\d+(\.\d+)?$/.test(v)) return { key: e.name, value: v, type: 'number' };
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { key: e.name, value: v, type: 'date' };
      return { key: e.name, value: v, type: 'text' };
    });
  }
  function fmScalar(v, inList) {
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    v = String(v).replace(/\r?\n/g, ' ');
    if (!v) return inList ? '""' : '';
    return /^\s|\s$|^[\[\]{}#&*!|>'"%@`]|^- |: | #/.test(v) || (inList && /[,\]]/.test(v)) ? '"' + v.replace(/"/g, '\\"') + '"' : v;
  }
  const fmValue = (v) => (Array.isArray(v) ? '[' + v.map((x) => fmScalar(x, true)).join(', ') + ']' : fmScalar(v));
  function setProperty(text, key, value) {
    const m = text.match(FM);
    if (!m) return `---\n${`${key}: ${fmValue(value)}`.trimEnd()}\n---\n` + text;
    const nl = m[0].includes('\r\n') ? '\r\n' : '\n', open = m[0].match(/^---[ \t]*\r?\n/)[0].length, closing = m[0].slice(open + m[1].length);
    const lines = m[1].split(/\r?\n/), ex = fmEntries(lines).filter((e) => e.key === key.toLowerCase()).pop();
    const rep = ex && ex.block && Array.isArray(value) ? [`${ex.name}:`, ...value.map((x) => `  - ${fmScalar(x, true)}`)] : [`${ex ? ex.name : key}: ${fmValue(value)}`.trimEnd()];
    if (ex) lines.splice(ex.start, ex.end - ex.start, ...rep); else lines.push(...rep);
    return m[0].slice(0, open) + lines.join(nl) + closing + text.slice(m[0].length);
  }
  function removeProperty(text, key) {
    const m = text.match(FM); if (!m) return text;
    const nl = m[0].includes('\r\n') ? '\r\n' : '\n', open = m[0].match(/^---[ \t]*\r?\n/)[0].length, closing = m[0].slice(open + m[1].length);
    const lines = m[1].split(/\r?\n/), drop = new Set();
    for (const e of fmEntries(lines)) if (e.key === key.toLowerCase()) for (let i = e.start; i < e.end; i++) drop.add(i);
    const kept = lines.filter((_, i) => !drop.has(i));
    if (!kept.some((l) => l.trim())) return text.slice(m[0].length);
    return m[0].slice(0, open) + kept.join(nl) + closing + text.slice(m[0].length);
  }
  const tagsOf = (text) => {
    const fm = frontmatter(text), t = fm.body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    const set = new Set([...t.matchAll(tagRe)].map((m) => m[2].toLowerCase()));
    const ft = fm.data.tags || fm.data.tag;
    for (const x of [].concat(ft || [])) for (const y of String(x).split(/[\s,]+/)) if (y) set.add(y.replace(/^#/, '').toLowerCase());
    return set;
  };
  // The part of a note under `heading` (up to the next heading of the same or higher level).
  function section(text, heading) {
    const L = text.split('\n'), want = heading.trim().toLowerCase();
    let a = -1, lvl = 0, fence = false;
    for (let i = 0; i < L.length; i++) {
      if (/^```/.test(L[i])) fence = !fence;
      const m = !fence && L[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (!m) continue;
      if (a < 0) { if (m[2].trim().toLowerCase() === want) { a = i; lvl = m[1].length; } }
      else if (m[1].length <= lvl) return L.slice(a, i).join('\n');
    }
    return a < 0 ? null : L.slice(a).join('\n');
  }
  // `- [ ]` / `- [x]` items outside code fences: [{line, done, text}] (line is 0-based in the whole text)
  function tasksOf(text) {
    const out = []; let fence = false;
    text.split('\n').forEach((l, line) => {
      if (/^```/.test(l)) { fence = !fence; return; }
      const m = !fence && l.match(/^\s*(?:[-*+]|\d+\.)\s+\[( |x|X)\]\s+(.*)$/);
      if (m) out.push({ line, done: m[1] !== ' ', text: m[2] });
    });
    return out;
  }

  /* ---- tiny syntax highlighter for fenced code (generic, good enough for most languages) ---- */
  const KW = 'abstract|as|async|await|break|case|catch|class|const|continue|def|default|defer|del|do|elif|else|enum|except|export|extends|false|final|finally|fn|for|from|func|function|go|if|impl|import|in|interface|is|lambda|let|loop|match|mod|new|nil|none|None|not|null|or|and|pass|pub|raise|return|self|static|struct|super|switch|this|throw|true|True|False|try|type|typeof|use|var|void|while|with|yield';
  const HASH_LANGS = /^(py|python|sh|bash|zsh|shell|yaml|yml|toml|rb|ruby|r|perl|make|dockerfile|conf|ini)$/i;
  function highlight(code, lang) {
    const comment = HASH_LANGS.test(lang || '') ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
    const re = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${KW})\\b`, 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : 'k';
      out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    return out + esc(code.slice(last));
  }

  function splitRow(line) {
    const cells = []; let cur = '', wiki = false, code = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '`') code = !code;
      if (!code && c === '[' && line[i + 1] === '[') wiki = true;
      if (c === ']' && line[i + 1] === ']') wiki = false;
      if (c === '|' && !wiki && !code) { cells.push(cur); cur = ''; } else cur += c;
    }
    cells.push(cur);
    if (!cells[0].trim()) cells.shift();
    if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
    return cells.map((c) => c.trim());
  }
  const sepRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  // create({ resolve }) -> { md, inline }; resolve(name) returns the canonical note name or null.
  function create({ resolve, embed }) {
    let depth = 0;
    function inline(s) {
      s = esc(s);
      const codes = [];
      s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
      s = s.replace(/(^|\s)\^([A-Za-z0-9-]+)[ \t]*$/gm, '$1<span class="blk" data-blk="$2"></span>');      // block id ^abc at the end of a line
      s = s.replace(linkRe, (_, t, a) => {
        let r = resolve(t), anchor = '', block = '';
        if (!r) { const sp = splitTarget(t.replace(/&amp;/g, '&')); if ((sp.heading || sp.block) && (r = resolve(sp.name))) { anchor = sp.heading; block = sp.block; } }
        const extra = (anchor ? ` data-anchor="${esc(anchor)}"` : '') + (block ? ` data-block="${esc(block)}"` : '');
        const label = a || (anchor ? t.replace('#', ' › ') : block ? t.replace(/\^.*/, '').trim() || t : t);
        return `<a href="#" data-note="${esc(r || t.trim())}"${extra} class="${r ? '' : 'new'}">${label}</a>`;
      });
      s = s.replace(tagRe, (_, pre, t) => `${pre}<a href="#" class="tag" data-tag="${t.toLowerCase()}">#${t}</a>`);
      s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, u) => {
        u = u.trim();
        if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^https?:/i.test(u)) return _;       // no javascript:/data: etc.
        let src;
        if (/^https?:/i.test(u)) src = u;
        else { try { src = '/files/' + encodeURI(decodeURIComponent(u.replace(/&amp;/g, '&')).replace(/^\.?\//, '')); } catch { return _; } }
        return `<img src="${src}" alt="${alt}" loading="lazy">`;
      });
      s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1<i>$2</i>')
        .replace(/~~(.+?)~~/g, '<s>$1</s>').replace(/==(?!\s)(.+?)==/g, '<mark>$1</mark>')
        .replace(/\[\^([^\]\s]+)\]/g, (_, k) => `<sup class="fn"><a href="#fn-${k}" id="fnr-${k}">${k}</a></sup>`);
      return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
    }

    function md(src) {
      const fm = frontmatter(src.replace(/\r/g, ''));
      const out = [], L = fm.body.split('\n');
      const metaKeys = Object.keys(fm.data);
      if (metaKeys.length) out.push(`<div class="fm">${metaKeys.map((k) => {
        const v = [].concat(fm.data[k]).filter((x) => x !== '');
        if (!v.length) return '';
        const html = k === 'tags' || k === 'tag' ? v.flatMap((x) => String(x).split(/[\s,]+/)).filter(Boolean).map((t) => t.replace(/^#/, '')).map((t) => `<a href="#" class="tag" data-tag="${esc(t.toLowerCase())}">#${esc(t)}</a>`).join(' ') : esc(v.join(', '));
        return `<span><b>${esc(k)}</b> ${html}</span>`;
      }).join('')}</div>`);
      let list = null, para = []; const notesFn = [];
      const flushP = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
      const flushL = () => { if (list) out.push(`</${list}>`); list = null; };
      for (let i = 0; i < L.length; i++) {
        const l = L[i], m = l.match(/^(#{1,6})\s+(.*)/);
        const fence = l.match(/^```\s*([\w+-]*)/);
        if (fence) {
          flushP(); flushL(); const b = [];
          while (++i < L.length && !/^```/.test(L[i])) b.push(L[i]);
          out.push(`<pre><code>${highlight(b.join('\n'), fence[1])}</code></pre>`); continue;
        }
        const em = embed && l.match(/^!\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|[^\]\n]*)?\]\]\s*$/);
        if (em) {
          flushP(); flushL();
          const r = resolve(em[1]), body = r && depth < 2 ? embed(r, em[2]) : null;
          if (body != null) { depth++; const inner = md(body); depth--; out.push(`<div class="embed"><div class="embed-title"><a href="#" data-note="${esc(r)}">${esc(r)}${em[2] ? ' › ' + esc(em[2]) : ''}</a></div>${inner}</div>`); }
          else out.push(`<p><a href="#" data-note="${esc(r || em[1].trim())}" class="${r ? '' : 'new'}">${esc(em[1].trim())}</a></p>`);
          continue;
        }
        if (m) { flushP(); flushL(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
        if (/^(-{3,}|\*{3,})\s*$/.test(l)) { flushP(); flushL(); out.push('<hr>'); continue; }
        if (l.includes('|') && i + 1 < L.length && sepRe.test(L[i + 1]) && L[i + 1].includes('-')) {
          const head = splitRow(l);
          const al = splitRow(L[i + 1]).map((c) => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
          const cell = (t, c, k) => `<${t}${al[k] ? ` style="text-align:${al[k]}"` : ''}>${inline(c)}</${t}>`;
          const rows = []; i += 2;
          while (i < L.length && L[i].trim() && L[i].includes('|')) rows.push(splitRow(L[i++]));
          i--; flushP(); flushL();
          out.push(`<table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${
            rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k] || '', k)).join('')}</tr>`).join('')}</tbody></table>`);
          continue;
        }
        const li = l.match(/^\s*([-*+]|\d+\.)\s+(.*)/);
        if (li) {
          flushP(); const t = /\d/.test(li[1]) ? 'ol' : 'ul';
          if (list !== t) { flushL(); out.push(`<${t}>`); list = t; }
          const task = li[2].match(/^\[( |x)\]\s+(.*)/i);
          out.push(task
            ? `<li style="list-style:none;margin-left:-1.2em"><input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}> ${inline(task[2])}</li>`
            : `<li>${inline(li[2])}</li>`);
          continue;
        }
        if (/^>\s?/.test(l)) {
          flushP(); flushL(); const q = [];
          while (i < L.length && /^>\s?/.test(L[i])) q.push(L[i++].replace(/^>\s?/, ''));
          i--;
          const c = q[0].match(/^\[!(\w+)\][+-]?\s*(.*)$/);
          if (c) {
            const kind = c[1].toLowerCase();
            out.push(`<div class="callout callout-${kind}"><div class="callout-title">${inline(c[2] || kind[0].toUpperCase() + kind.slice(1))}</div>${q.length > 1 ? `<div>${inline(q.slice(1).join(' '))}</div>` : ''}</div>`);
          } else out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
          continue;
        }
        const fd = l.match(/^\[\^([^\]\s]+)\]:\s*(.*)/);
        if (fd) { flushP(); flushL(); notesFn.push([fd[1], fd[2]]); continue; }
        if (!l.trim()) { flushP(); flushL(); continue; }
        flushL(); para.push(l.trim());
      }
      flushP(); flushL();
      if (notesFn.length) out.push(`<hr><ol class="footnotes">${notesFn.map(([k, t]) => `<li id="fn-${esc(k)}">${inline(t)} <a href="#fnr-${esc(k)}">↩</a></li>`).join('')}</ol>`);
      return out.join('\n');
    }
    return { md, inline };
  }

  /* ---- editor helpers: each returns an edit {start, end, insert, selStart, selEnd} or null ---- */
  const lineStart = (t, p) => t.lastIndexOf('\n', p - 1) + 1;
  const lineEnd = (t, p) => { const i = t.indexOf('\n', p); return i < 0 ? t.length : i; };

  // Enter inside a list item: continue the list, or end it if the item is empty.
  function listEnter(t, pos) {
    const ls = lineStart(t, pos), le = lineEnd(t, pos), line = t.slice(ls, le);
    const m = line.match(/^(\s*)([-*+]|(\d+)\.)\s+(\[[ xX]\]\s+)?/);
    if (!m || pos < ls + m[0].length) return null;
    if (line.slice(m[0].length).trim() === '' && pos === le) {          // empty item: remove marker
      return { start: ls, end: le, insert: '', selStart: ls, selEnd: ls };
    }
    const marker = m[3] ? `${Number(m[3]) + 1}.` : m[2];
    const ins = `\n${m[1]}${marker} ${m[4] ? '[ ] ' : ''}`;
    return { start: pos, end: pos, insert: ins, selStart: pos + ins.length, selEnd: pos + ins.length };
  }

  // Tab / Shift+Tab: indent or outdent every selected line by two spaces.
  function indentLines(t, s, e, outdent) {
    const a = lineStart(t, s), b = lineEnd(t, e > s && t[e - 1] === '\n' ? e - 1 : e);
    const lines = t.slice(a, b).split('\n');
    let delta0 = 0, total = 0;
    const res = lines.map((ln, i) => {
      let nl, d;
      if (outdent) { const mm = ln.match(/^ {1,2}/); d = mm ? -mm[0].length : 0; nl = ln.slice(-d); }
      else { d = 2; nl = '  ' + ln; }
      if (i === 0) delta0 = d;
      total += d; return nl;
    });
    const insert = res.join('\n');
    return { start: a, end: b, insert, selStart: Math.max(a, s + delta0), selEnd: Math.max(a, e + total) };
  }

  // Cmd+B / Cmd+I: wrap the selection in a marker, or unwrap if already wrapped.
  function wrap(t, s, e, mark) {
    const n = mark.length;
    if (s >= n && t.slice(s - n, s) === mark && t.slice(e, e + n) === mark) {
      return { start: s - n, end: e + n, insert: t.slice(s, e), selStart: s - n, selEnd: e - n };
    }
    const sel = t.slice(s, e);
    return { start: s, end: e, insert: mark + sel + mark, selStart: s + n, selEnd: s + n + sel.length };
  }

  // [[ autocomplete: returns { query, start } when the caret is inside an unclosed [[ ... ]]
  function wikiContext(t, pos) {
    const m = t.slice(Math.max(0, pos - 80), pos).match(/\[\[([^\]\[\n|]*)$/);
    return m ? { query: m[1], start: pos - m[1].length } : null;
  }


  // [[Note#Heading]] / [[Note^block]] / [[#Heading]] -> { name, heading, block }
  function splitTarget(t) {
    const m = String(t).trim().match(/^([^#^]*)(?:#([^^]*))?(?:\^(.+))?$/);
    return { name: (m[1] || '').trim(), heading: (m[2] || '').trim(), block: (m[3] || '').trim() };
  }
  // aliases from frontmatter (`aliases: [a, b]`, a list, or `alias: a, b`)
  function aliasesOf(text) {
    const d = frontmatter(text).data, v = d.aliases ?? d.alias ?? [];
    return [].concat(v).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  }
  // Search syntax: words (AND), "exact phrase", tag:x, path:x, file:x, /regex/, and a leading - to exclude.
  function parseQuery(q) {
    const out = { terms: [], phrases: [], tags: [], paths: [], files: [], regex: [], not: [] };
    const toks = String(q || '').match(/-?(?:\w+:)?(?:"[^"]*"|\/(?:[^\/\\]|\\.)+\/[a-z]*|\S+)/g) || [];
    for (const raw of toks) {
      let t = raw, neg = false;
      if (t.length > 1 && t[0] === '-') { neg = true; t = t.slice(1); }
      let kind = 'terms';
      const op = t.match(/^(tag|path|file):(.*)$/i);
      if (op) { kind = { tag: 'tags', path: 'paths', file: 'files' }[op[1].toLowerCase()]; t = op[2]; }
      const rx = !op && t.match(/^\/((?:[^\/\\]|\\.)+)\/([a-z]*)$/);
      if (rx) { try { const re = new RegExp(rx[1], rx[2].includes('i') ? rx[2] : rx[2] + 'i'); neg ? out.not.push({ re }) : out.regex.push(re); } catch {} continue; }
      if (t[0] === '"' && !op) { kind = 'phrases'; t = t.replace(/^"|"$/g, ''); } else t = t.replace(/^"|"$/g, '');
      t = t.toLowerCase(); if (kind === 'tags') t = t.replace(/^#/, '');
      if (!t) continue;
      neg ? out.not.push({ kind, t }) : out[kind].push(t);
    }
    return out;
  }
  const emptyQuery = (p) => !(p.terms.length || p.phrases.length || p.tags.length || p.paths.length || p.files.length || p.regex.length || p.not.length);
  function searchMatch(p, name, text) {
    const n = name.toLowerCase(), body = text.toLowerCase(), both = n + '\n' + body;
    const has = (kind, t) => kind === 'tags' ? [...tagsOf(text)].some((x) => x === t || x.startsWith(t + '/'))
      : kind === 'paths' ? n.includes(t) : kind === 'files' ? n.split('/').pop().includes(t) : both.includes(t);
    if (p.not.some((x) => x.re ? x.re.test(name + '\n' + text) : has(x.kind, x.t))) return false;
    return p.terms.every((t) => both.includes(t)) && p.phrases.every((t) => both.includes(t)) && p.regex.every((re) => re.test(name + '\n' + text))
      && p.tags.every((t) => has('tags', t)) && p.paths.every((t) => n.includes(t)) && p.files.every((t) => n.split('/').pop().includes(t));
  }
  // where to show a snippet for a match: index of the first positive term/phrase/regex in the body, or -1
  function searchSnippetAt(p, text) {
    const lower = text.toLowerCase();
    for (const t of [...p.phrases, ...p.terms]) { const i = lower.indexOf(t); if (i >= 0) return i; }
    for (const re of p.regex) { const m = re.exec(text); if (m) return m.index; }
    return -1;
  }


  // Folder tree from note names (and any empty folders): { type:'folder', name, path, count, children } / { type:'note', name, label }
  function buildTree(names, folders = []) {
    const root = { type: 'folder', name: '', path: '', children: [] }, dirs = new Map([['', root]]);
    const dir = (p) => {
      if (dirs.has(p)) return dirs.get(p);
      const i = p.lastIndexOf('/'), parent = dir(i < 0 ? '' : p.slice(0, i)), d = { type: 'folder', name: p.slice(i + 1), path: p, children: [] };
      parent.children.push(d); dirs.set(p, d); return d;
    };
    for (const f of folders) if (f) dir(f);
    for (const n of names) { const i = n.lastIndexOf('/'); dir(i < 0 ? '' : n.slice(0, i)).children.push({ type: 'note', name: n, label: n.slice(i + 1) }); }
    const key = (x) => (x.type === 'folder' ? x.name : x.label);
    const walk = (d) => {
      d.children.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : key(a).localeCompare(key(b))));
      d.count = d.children.reduce((a, c) => a + (c.type === 'note' ? 1 : walk(c)), 0); return d.count;
    };
    walk(root); return root;
  }


  // ---- Live Preview (beta): classify each source line, then render it as rich text. The active line is shown raw by the editor. ----
  function lpClassify(lines) {
    const out = []; let fence = false, fmEnd = -1;
    if (lines.length && /^---\s*$/.test(lines[0])) for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) { fmEnd = i; break; }
    lines.forEach((l, i) => {
      let m;
      if (i <= fmEnd) return out.push({ kind: 'fm', prefix: '', content: l });
      if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return out.push({ kind: 'fence', prefix: '', content: l }); }
      if (fence) return out.push({ kind: 'code', prefix: '', content: l });
      if ((m = l.match(/^(#{1,6})\s+(.*?)\s*$/))) { const pre = l.match(/^#{1,6}\s+/)[0]; return out.push({ kind: 'h', level: m[1].length, prefix: pre, content: l.slice(pre.length).replace(/\s+#+\s*$/, '') }); }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(l)) return out.push({ kind: 'hr', prefix: '', content: l });
      if ((m = l.match(/^((?:\s*>)+\s?)(.*)$/))) return out.push({ kind: 'quote', prefix: m[1], content: m[2] });
      if ((m = l.match(/^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]\s+/))) return out.push({ kind: 'task', indent: Math.floor(m[1].length / 2), checked: m[3] !== ' ', prefix: m[0], content: l.slice(m[0].length) });
      if ((m = l.match(/^(\s*)([-*+])\s+/))) return out.push({ kind: 'ul', indent: Math.floor(m[1].length / 2), prefix: m[0], content: l.slice(m[0].length) });
      if ((m = l.match(/^(\s*)(\d+)\.\s+/))) return out.push({ kind: 'ol', indent: Math.floor(m[1].length / 2), num: m[2], prefix: m[0], content: l.slice(m[0].length) });
      if (/^\s*\|/.test(l)) return out.push({ kind: 'table', prefix: '', content: l });
      out.push({ kind: l.trim() === '' ? 'blank' : 'p', prefix: '', content: l });
    });
    return out;
  }
  // -> [{ kind, html, prefix, content, ... }]; `inline` renders one line of inline Markdown (from create()).
  function lpRender(lines, inline) {
    const raw = (l) => `<span class="lp-raw">${esc(l) || '<br>'}</span>`;
    return lpClassify(lines).map((b, i) => {
      const body = () => (b.content.trim() ? inline(b.content) : '<br>'), ind = ` style="--ind:${b.indent || 0}"`;
      let html;
      switch (b.kind) {
        case 'h': html = `<span class="lp-h lp-h${b.level}">${body()}</span>`; break;
        case 'quote': html = `<span class="lp-q">${body()}</span>`; break;
        case 'ul': html = `<span class="lp-li"${ind}>${body()}</span>`; break;
        case 'ol': html = `<span class="lp-li lp-ol"${ind}><span class="lp-num" contenteditable="false">${b.num}.</span>${body()}</span>`; break;
        case 'task': html = `<span class="lp-li lp-task${b.checked ? ' lp-done' : ''}"${ind}><span class="lp-cbw" contenteditable="false"><input type="checkbox" class="lp-cb"${b.checked ? ' checked' : ''}></span>${body()}</span>`; break;
        case 'hr': html = '<span class="lp-hr"><hr></span>'; break;
        case 'fm': case 'fence': case 'code': case 'table': html = raw(lines[i]); break;
        case 'blank': html = '<br>'; break;
        default: html = body();
      }
      return { ...b, html };
    });
  }
  // The source column that corresponds to having `shown` (the visible text) before the caret in a rendered line:
  // markers are skipped by matching the shown characters in order against the source content.
  function lpColumn(block, shown) {
    if (!shown) return block.prefix.length;
    let j = 0; const c = block.content;
    for (let s = 0; s < c.length; s++) if (c[s] === shown[j] && ++j === shown.length) return block.prefix.length + s + 1;
    return block.prefix.length + c.length;
  }

  // ---- typing helpers: auto-pairing, pasting a link over a selection, task toggling. All return an edit { start, end, insert, selStart, selEnd } or null. ----
  const PAIRS = { '(': ')', '[': ']', '{': '}', '`': '`', '"': '"' }, CLOSERS = new Set([')', ']', '}', '`', '"']);
  const WRAPPERS = { ...PAIRS, '*': '*', _: '_', '~': '~', '=': '=' };
  function autoPair(t, s, e, key) {
    if (key.length !== 1) return null;
    const prev = t[s - 1] || '', next = t[e] || '';
    if (s !== e) {                                              // a selection: wrap it
      const close = WRAPPERS[key]; if (!close || t.slice(s, e).includes('\n')) return null;
      return { start: s, end: e, insert: key + t.slice(s, e) + close, selStart: s + 1, selEnd: e + 1 };
    }
    if (CLOSERS.has(key) && next === key) return { start: s, end: s, insert: '', selStart: s + 1, selEnd: s + 1 };   // typed the closer that is already there
    const close = PAIRS[key]; if (!close) return null;
    if (key === '`' && (prev === '`' || next === '`')) return null;                                   // leave ``` fences alone
    if ((key === '"' || key === '`') && /[\w]/.test(prev)) return null;                               // a quote after a word is an apostrophe / end quote
    if (next && !/[\s)\]}.,;:!?]/.test(next)) return null;                                           // only pair before whitespace, a closer or the end
    return { start: s, end: s, insert: key + close, selStart: s + 1, selEnd: s + 1 };
  }
  function backspacePair(t, s, e) {
    if (s !== e || s < 1) return null;
    return PAIRS[t[s - 1]] && PAIRS[t[s - 1]] === t[s] ? { start: s - 1, end: s + 1, insert: '', selStart: s - 1, selEnd: s - 1 } : null;
  }
  function pasteLink(t, s, e, clip) {
    const url = String(clip || '').trim(), sel = t.slice(s, e);
    if (s === e || sel.includes('\n') || !/^https?:\/\/[^\s]+$/i.test(url)) return null;
    const ins = `[${sel}](${url})`;
    return { start: s, end: e, insert: ins, selStart: s + ins.length, selEnd: s + ins.length };
  }
  function toggleTask(t, pos) {
    const a = lineStart(t, pos), b = lineEnd(t, pos), line = t.slice(a, b);
    let m, nl;
    if ((m = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/))) nl = line.slice(0, m[1].length) + '[' + (m[2] === ' ' ? 'x' : ' ') + ']' + line.slice(m[0].length);
    else if ((m = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)/))) nl = m[1] + '[ ] ' + line.slice(m[1].length);
    else { const ind = line.match(/^\s*/)[0]; nl = ind + '- [ ] ' + line.slice(ind.length); }
    const caret = Math.min(Math.max(pos + (nl.length - line.length), a), a + nl.length);
    return { start: a, end: b, insert: nl, selStart: caret, selEnd: caret };
  }

  // line-level toggles used by the phone keyboard bar
  function reline(t, pos, fn) {
    const a = lineStart(t, pos), b = lineEnd(t, pos), line = t.slice(a, b), nl = fn(line);
    const caret = Math.min(Math.max(pos + (nl.length - line.length), a), a + nl.length);
    return { start: a, end: b, insert: nl, selStart: caret, selEnd: caret };
  }
  const toggleBullet = (t, pos) => reline(t, pos, (l) => {
    const m = l.match(/^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/);
    return m ? m[1] + l.slice(m[0].length) : l.match(/^\s*/)[0] + '- ' + l.trimStart();
  });
  const toggleHeading = (t, pos) => reline(t, pos, (l) => {                  // none -> # -> ## -> ### -> none
    const m = l.match(/^(#{1,6})\s+/), level = m ? m[1].length : 0, rest = m ? l.slice(m[0].length) : l, next = level >= 3 ? 0 : level + 1;
    return (next ? '#'.repeat(next) + ' ' : '') + rest;
  });

  // ---- settings and keyboard shortcuts (pure, so they can be tested without a browser) ----
  const FONTS = ['system', 'serif', 'mono'], WIDTHS = ['normal', 'wide', 'full'];
  const COMBO = /^(?:(?:mod|alt|shift)\+){0,3}[^\s+]+$|^(?:(?:mod|alt|shift)\+){1,3}\+$/;
  function normalizeSettings(o) {
    o = o && typeof o === 'object' ? o : {};
    const folder = (v, d) => (typeof v === 'string' ? v.trim().replace(/\\/g, '/').split('/').map((x) => x.trim()).filter((x) => x && x !== '.' && x !== '..' && !x.startsWith('.')).join('/') : d);
    const hotkeys = {};
    if (o.hotkeys && typeof o.hotkeys === 'object') for (const [id, c] of Object.entries(o.hotkeys)) if (/^[\w-]+$/.test(id) && typeof c === 'string' && COMBO.test(c)) hotkeys[id] = c;
    return {
      font: FONTS.includes(o.font) ? o.font : 'system',
      width: WIDTHS.includes(o.width) ? o.width : 'normal',
      accent: typeof o.accent === 'string' && /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent.toLowerCase() : '',
      dailyFolder: folder(o.dailyFolder, 'daily'),
      dailyTemplate: typeof o.dailyTemplate === 'string' ? o.dailyTemplate.trim().replace(/^\/+|\.md$/gi, '') || 'templates/Daily' : 'templates/Daily',
      newFolder: folder(o.newFolder, ''),
      livePreview: o.livePreview === true,
      spellcheck: o.spellcheck === true,
      autoPair: o.autoPair !== false,
      hotkeys,
      snippets: Array.isArray(o.snippets) ? [...new Set(o.snippets.filter((n) => typeof n === 'string' && /^\w[\w .-]*\.css$/.test(n)))] : [],
    };
  }
  // A key event (or anything shaped like one) as "mod+alt+shift+key"; '' for a bare modifier press.
  function comboOf(e) {
    let k = String(e.key || '').toLowerCase();
    const code = e.code || '', m = /^Key([A-Z])$/.exec(code) || /^Digit(\d)$/.exec(code);
    if (m && (e.altKey || k.length !== 1)) k = m[1].toLowerCase();
    if (!k || ['control', 'meta', 'alt', 'shift', 'altgraph', 'dead'].includes(k)) return '';
    if (k === ' ') k = 'space';
    return [(e.metaKey || e.ctrlKey) && 'mod', e.altKey && 'alt', e.shiftKey && 'shift', k].filter(Boolean).join('+');
  }
  const comboValid = (c) => /^(?:(?:mod|alt)\+)/.test(c) || /(^|\+)f(?:[1-9]|1[0-2])$/.test(c);   // a bare letter must never steal typing
  function comboLabel(c, mac) {
    return c.split('+').map((p, i, a) => (p === 'mod' ? (mac ? '⌘' : 'Ctrl') : p === 'alt' ? (mac ? '⌥' : 'Alt') : p === 'shift' ? (mac ? '⇧' : 'Shift') : (i === a.length - 1 ? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)) : p))).join(mac ? '' : '+');
  }

  // templates: {{date}} {{time}} {{datetime}} {{title}} (case-insensitive); unknown {{x}} are left alone
  function fillTemplate(text, title, now) {
    const d = now || new Date(), p = (x) => String(x).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const vars = { date, time, datetime: date + ' ' + time, title: title || '' };
    return String(text).replace(/\{\{\s*(date|time|datetime|title)\s*\}\}/gi, (_, k) => vars[k.toLowerCase()]);
  }

  // find in note: case-insensitive literal matches as [{start, end}]
  function findAll(text, query) {
    if (!query) return [];
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), out = [];
    for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  }

  // slash menu: "/" at the start of a line (after indentation) opens a block picker; returns { query, start } or null
  function slashContext(t, pos) {
    const ls = t.lastIndexOf('\n', pos - 1) + 1, m = t.slice(ls, pos).match(/^\s*\/([a-z0-9]*)$/i);
    return m ? { query: m[1].toLowerCase(), start: pos - m[1].length - 1 } : null;
  }
  const SLASH = [
    { label: 'Heading 1', keys: 'h1 heading title', text: '# ' },
    { label: 'Heading 2', keys: 'h2 heading', text: '## ' },
    { label: 'Heading 3', keys: 'h3 heading', text: '### ' },
    { label: 'Task', keys: 'task todo checkbox', text: '- [ ] ' },
    { label: 'Bullet list', keys: 'bullet list ul', text: '- ' },
    { label: 'Numbered list', keys: 'numbered list ol', text: '1. ' },
    { label: 'Quote', keys: 'quote blockquote', text: '> ' },
    { label: 'Code block', keys: 'code fence', text: '```\n\n```', caret: 4 },
    { label: 'Table', keys: 'table grid', text: '| Column | Column |\n| --- | --- |\n|  |  |', caret: 36 },
    { label: 'Divider', keys: 'divider rule hr line', text: '---\n' },
    { label: 'Link to note', keys: 'link wikilink note', text: '[[', caret: 2 },
    { label: 'Today’s date', keys: 'date today', date: true },
  ];
  // items whose label or keywords match; `now` makes the date item testable
  function slashItems(query, now) {
    const q = (query || '').toLowerCase(), d = now || new Date(), p = (x) => String(x).padStart(2, '0');
    const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return SLASH.filter((i) => !q || i.label.toLowerCase().startsWith(q) || i.keys.split(' ').some((k) => k.startsWith(q)))
      .map((i) => { const text = i.date ? iso : i.text; return { label: i.label, text, caret: i.caret === undefined ? text.length : i.caret }; });
  }

  /* ---- live editor highlighting ----
     Returns HTML whose text content is EXACTLY the input (only <span>s added), so it can sit behind a transparent textarea. */
  const INLINE = /(`[^`\n]+`)|(\[\[[^\]\n]+\]\])|(!?\[[^\]\n]*\]\([^)\n]*\))|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(~~[^~\n]+~~)|(^|[\s(])(#(?=[\w\/-]*[A-Za-z_])[\w\/-]+)/g;
  const span = (cls, t) => `<span class="${cls}">${esc(t)}</span>`;
  function inlineHL(s, pipes) {
    const plain = (t) => (pipes ? esc(t).replace(/\|/g, '<span class="mk-m">|</span>') : esc(t));
    let out = '', last = 0;
    for (const m of s.matchAll(INLINE)) {
      out += plain(s.slice(last, m.index));
      if (m[1]) out += span('mk-c', m[1]);
      else if (m[2]) out += span('mk-l', m[2]);
      else if (m[3]) out += span('mk-u', m[3]);
      else if (m[4]) out += span('mk-b', m[4]);
      else if (m[5]) out += span('mk-i', m[5]);
      else if (m[6]) out += span('mk-x', m[6]);
      else out += esc(m[7]) + span('mk-t', m[8]);
      last = m.index + m[0].length;
    }
    return out + plain(s.slice(last));
  }
  function highlightMarkdown(text) {
    const lines = text.split('\n'), out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], f = l.match(/^```\s*([\w+-]*)/);
      if (f) {
        out.push(span('mk-m', l));
        const body = [];
        while (i + 1 < lines.length && !/^```/.test(lines[i + 1])) body.push(lines[++i]);
        if (body.length) out.push(highlight(body.join('\n'), f[1]));
        if (i + 1 < lines.length) out.push(span('mk-m', lines[++i]));
        continue;
      }
      let m;
      if (/^#{1,6}(\s|$)/.test(l)) out.push(`<span class="mk-h">${inlineHL(l)}</span>`);
      else if (/^(-{3,}|\*{3,})\s*$/.test(l)) out.push(span('mk-m', l));
      else if ((m = l.match(/^(>\s?)(.*)$/))) out.push(span('mk-m', m[1]) + `<span class="mk-q">${inlineHL(m[2])}</span>`);
      else if ((m = l.match(/^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\]\s+)?(.*)$/)))
        out.push(esc(m[1]) + span('mk-m', m[2] + m[3]) + (m[4] ? span('mk-n', m[4]) : '') + inlineHL(m[5]));
      else if (/^\s*\|/.test(l) || (sepRe.test(l) && l.includes('-'))) out.push(inlineHL(l, true));
      else out.push(inlineHL(l));
    }
    return out.join('\n');
  }

  // Notes that mention `name` in plain text without linking to it: [{name, index}]
  function unlinkedMentions(notes, name) {
    const short = name.split('/').pop(), lc = name.toLowerCase(), sl = short.toLowerCase(), out = [];
    if (short.length < 3) return out;
    const re = new RegExp('(^|[^\\w\\[])' + short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w\\]])', 'i');
    for (const n of notes) {
      if (n.name.toLowerCase() === lc) continue;
      const linked = [...n.text.matchAll(linkRe)].some((m) => { const t = m[1].trim().toLowerCase(); return t === lc || t === sl; });
      if (linked) continue;
      const text = n.text.replace(/```[\s\S]*?```/g, (c) => ' '.repeat(c.length)).replace(linkRe, (c) => ' '.repeat(c.length));
      const m = re.exec(text);
      if (m) out.push({ name: n.name, index: m.index + m[1].length });
    }
    return out;
  }

  // Literal, case-insensitive replace of every match: { text, count }
  function replaceAll(text, query, repl) {
    const hits = findAll(text, query); if (!hits.length) return { text, count: 0 };
    let out = '', last = 0;
    for (const h of hits) { out += text.slice(last, h.start) + repl; last = h.end; }
    return { text: out + text.slice(last), count: hits.length };
  }

  const api = { toggleBullet, toggleHeading, autoPair, backspacePair, pasteLink, toggleTask, lpClassify, lpRender, lpColumn, normalizeSettings, comboOf, comboValid, comboLabel, buildTree, properties, setProperty, removeProperty, splitTarget, aliasesOf, parseQuery, emptyQuery, searchMatch, searchSnippetAt, replaceAll, frontmatter, section, tasksOf, unlinkedMentions, highlightMarkdown, esc, linkRe, tagRe, tagsOf, highlight, splitRow, create, listEnter, indentLines, wrap, wikiContext, slashContext, slashItems, fillTemplate, findAll };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MD = api;
})(typeof window !== 'undefined' ? window : globalThis);
