// Markdown rendering and editor text helpers. Pure functions, no DOM: shared by the browser UI and the tests.
(function (root) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const linkRe = /\[\[([^\]\|\n]+?)(?:\|([^\]\n]+))?\]\]/g;
  const tagRe = /(^|[\s(])#((?=[\w\/-]*[A-Za-z_])[\w\/-]+)/g;
  // Leading `---` YAML-ish block: simple `key: value`, `key: [a, b]` and `- item` lists. -> { data, body }
  function frontmatter(text) {
    const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!m) return { data: {}, body: text };
    const data = {}; let key = null;
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/), it = line.match(/^\s+-\s+(.*)$|^-\s+(.*)$/);
      const clean = (v) => v.trim().replace(/^["']|["']$/g, '');
      if (kv) {
        key = kv[1].toLowerCase(); const v = kv[2].trim();
        data[key] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(clean).filter(Boolean) : v ? clean(v) : [];
      } else if (it && key) { if (!Array.isArray(data[key])) data[key] = data[key] ? [data[key]] : []; data[key].push(clean(it[1] ?? it[2])); }
    }
    return { data, body: text.slice(m[0].length) };
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
      s = s.replace(linkRe, (_, t, a) => {
        const r = resolve(t);
        return `<a href="#" data-note="${esc(r || t.trim())}" class="${r ? '' : 'new'}">${a || t}</a>`;
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

  const api = { replaceAll, frontmatter, section, tasksOf, unlinkedMentions, highlightMarkdown, esc, linkRe, tagRe, tagsOf, highlight, splitRow, create, listEnter, indentLines, wrap, wikiContext, slashContext, slashItems, fillTemplate, findAll };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MD = api;
})(typeof window !== 'undefined' ? window : globalThis);
