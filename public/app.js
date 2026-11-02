const $ = (s) => document.querySelector(s);
let notes = new Map();   // name -> {text, mtime}
let activeTag = null;
let graphOn = false, gRaf = 0, graphScope = 0;   // graphScope: 0 = all notes, 1/2 = neighbourhood of the open note
let cur = null, preview = false, timer = null, dirty = false;

const api = async (url, opt) => {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
};
const { esc, linkRe, tagsOf } = MD;
let aliasMap = null, aliasAt = 0;                                   // frontmatter aliases -> note name (rebuilt lazily)
const aliases = () => {
  if (aliasMap && Date.now() - aliasAt < 2000) return aliasMap;
  aliasMap = new Map(); aliasAt = Date.now();
  for (const n of notes.values()) if (n.text.startsWith('---')) for (const a of MD.aliasesOf(n.text)) aliasMap.set(a.toLowerCase(), n.name);
  return aliasMap;
};
const resolve = (t) => { t = t.trim(); if (!t) return cur; if (notes.has(t)) return t;
  const l = t.toLowerCase(); for (const n of notes.keys()) if (n.toLowerCase() === l || n.split('/').pop().toLowerCase() === l) return n;
  return aliases().get(l) || null; };
// a link target as written, e.g. "Note#Heading", "Note^id", "#Heading" (current note) or an alias -> note name or null
const resolveLink = (t) => { const r = resolve(t); if (r) return r; const sp = MD.splitTarget(t); return sp.name ? resolve(sp.name) : (sp.heading || sp.block) ? cur : null; };

let folders = [];
async function load() {
  const [fresh, fl] = await Promise.all([api('/api/notes'), api('/api/folders').catch(() => folders)]);
  folders = fl;
  const keep = dirty && cur ? notes.get(cur) : null;      // never replace text the user typed but hasn't saved yet
  aliasMap = null;
  notes = new Map(fresh.map((n) => [n.name, { ...n, base: n.mtime }]));
  if (keep) notes.set(keep.name, keep);
  renderList();
}

const { md } = MD.create({ resolve: (t) => resolve(t), embed: (name, h) => {
  const n = notes.get(name); if (!n) return null;
  const body = MD.frontmatter(n.text).body;
  return h ? MD.section(body, h) : body;
} });

/* ---------- UI ---------- */
let tagsOpen = false;
const savedSearches = () => { try { return JSON.parse(localStorage.getItem('searches') || '[]').filter((x) => typeof x === 'string'); } catch { return []; } };
const setSearches = (a) => { try { localStorage.setItem('searches', JSON.stringify(a.slice(0, 20))); } catch {} };
function renderTags() {
  const counts = new Map();
  for (const n of notes.values()) for (const t of tagsOf(n.text)) counts.set(t, (counts.get(t) || 0) + 1);
  if (activeTag && !counts.has(activeTag)) activeTag = null;
  const all = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40), cap = tagsOpen ? 40 : 8;
  let shown = all.slice(0, cap);
  if (activeTag && !shown.some(([t]) => t === activeTag)) shown = [...shown.slice(0, cap - 1), all.find(([t]) => t === activeTag)];
  const saved = savedSearches(), cq = $('#q').value.trim();
  const ssHtml = saved.map((x, i) => `<span class="chip ss" data-ss="${i}" title="${esc(x)}">⌕ ${esc(x.length > 18 ? x.slice(0, 17) + '…' : x)}<span class="x" data-ssdel="${i}" title="Remove">×</span></span>`).join('')
    + (cq && !saved.includes(cq) ? `<span class="chip ss" id="sssave" title="Save this search">+ Save search</span>` : '');
  $('#tags').innerHTML = ssHtml + shown.map(([t, c]) => `<span class="chip${t === activeTag ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)} ${c}</span>`).join('')
    + (all.length > 8 ? `<span class="chip more" id="tagmore">${tagsOpen ? 'Fewer' : `+${all.length - shown.length} more`}</span>` : '');
}
let pins = new Set(); try { pins = new Set(JSON.parse(localStorage.getItem('pins') || '[]')); } catch {}
function savePins() { try { localStorage.setItem('pins', JSON.stringify([...pins])); } catch {} }
function renderPin() { const on = !!cur && pins.has(cur); $('#pin').disabled = $('#exp').disabled = !cur; const b = $('#pin'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.title = on ? 'Unpin from the top of the list' : 'Pin to top of the list'; b.setAttribute('aria-label', on ? 'Unpin' : 'Pin'); }
function renderList() {
  if (trashMode) return;
  renderTags();
  const pq = MD.parseQuery($('#q').value), q = !MD.emptyQuery(pq);
  let rows = [...notes.values()];
  if (activeTag) rows = rows.filter((n) => tagsOf(n.text).has(activeTag));
  if (q) rows = rows.filter((n) => MD.searchMatch(pq, n.name, n.text));
  if (view === 'files' && !q && !activeTag) { $('#list').innerHTML = treeHtml(MD.buildTree([...notes.keys()], folders), 0) || '<div class="empty">No notes</div>'; return; }
  rows.sort((a, b) => pins.has(b.name) - pins.has(a.name) || b.mtime - a.mtime);   // pinned first, then newest
  $('#list').innerHTML = rows.map((n) => {
    let snip = '';
    if (q) { const i = MD.searchSnippetAt(pq, n.text);
      if (i >= 0) snip = `<span class="snip">${esc(n.text.slice(Math.max(0, i - 20), i + 50).replace(/\n/g, ' '))}</span>`; }
    return `<div class="item${n.name === cur ? ' on' : ''}" data-note="${esc(n.name)}">${pins.has(n.name) ? '📌 ' : ''}${esc(n.name)}${snip}</div>`;
  }).join('') || '<div class="empty">No notes</div>';
}
function renderBack() {
  if (!cur) { $('#back').innerHTML = ''; return; }
  const hits = [];
  for (const n of notes.values()) {
    if (n.name === cur) continue;
    for (const m of n.text.matchAll(linkRe)) { if (resolveLink(m[1]) === cur) { hits.push(n.name); break; } }
  }
  const out = [], seenOut = new Set();
  for (const m of notes.get(cur).text.matchAll(linkRe)) { const r = resolveLink(m[1]); if (r && r !== cur && !seenOut.has(r)) { seenOut.add(r); out.push(r); } }
  const um = MD.unlinkedMentions([...notes.values()], cur);
  $('#back').innerHTML = (hits.length ? 'Linked from: ' + hits.map((h) => `<a data-note="${esc(h)}">${esc(h)}</a>`).join('') : 'No backlinks')
    + (out.length ? `<span class="um" id="outgoing"><b>Links to:</b> ` + out.map((h) => `<a data-note="${esc(h)}">${esc(h)}</a>`).join(' ') + '</span>' : '')
    + (um.length ? `<span class="um" id="um"><b>Unlinked mentions:</b> ` + um.map((u) => `<a data-note="${esc(u.name)}">${esc(u.name)}</a><a data-link="${esc(u.name)}" title="Turn the mention into a [[link]]">link</a>`).join(' ') + '</span>' : '');
}
async function linkMention(from) {
  const n = notes.get(from); if (!n || !cur) return;
  const um = MD.unlinkedMentions([n], cur)[0]; if (!um) return;
  const short = cur.split('/').pop(), orig = n.text.slice(um.index, um.index + short.length);
  const link = n.text.slice(0, um.index) + (cur === orig ? `[[${cur}]]` : `[[${cur}|${orig}]]`) + n.text.slice(um.index + short.length);
  try {
    const r = await api('/api/note?name=' + encodeURIComponent(from), { method: 'PUT', body: link, headers: { 'x-base-mtime': String(n.base ?? 0) } });
    n.text = link; n.base = r.mtime; $('#status').textContent = `Linked in ${from}`; renderBack();
  } catch (e) { $('#status').textContent = 'Could not link: ' + e.message; }
}
/* outline: headings of the open note (ignoring fenced code); click to jump */
function headingsOf(text) {
  const out = []; let fence = false, off = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) { const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/); if (m) out.push({ level: m[1].length, text: m[2], off }); }
    off += line.length + 1;
  }
  return out;
}
function renderOutline() {
  const el = $('#outline'), hs = cur && !graphOn && notes.get(cur) ? headingsOf(notes.get(cur).text) : [];
  el.style.display = hs.length > 1 ? 'block' : 'none';
  el.innerHTML = hs.length > 1 ? 'Outline: ' + hs.map((h, i) => `<a data-h="${i}" class="l${Math.min(h.level, 3)}">${esc(h.text.replace(/[*_`]/g, ''))}</a>`).join('') : '';
}
function gotoHeading(i) {
  const h = headingsOf(notes.get(cur).text)[i]; if (!h) return;
  if (preview) { const el = $('#pv')?.querySelectorAll('h1,h2,h3,h4,h5,h6')[i]; if (el) $('#pane').scrollTop += el.getBoundingClientRect().top - $('#pane').getBoundingClientRect().top - 12; return; }
  const ed = $('#ed'); if (!ed) return;
  ed.focus(); ed.setSelectionRange(h.off, h.off); caretIntoView(true);
}
function gotoAnchor(h) {
  const i = headingsOf(notes.get(cur).text).findIndex((x) => x.text.replace(/[*_`]/g, '').toLowerCase() === h.toLowerCase());
  if (i >= 0) gotoHeading(i);
}
function gotoBlock(id) {
  const t = notes.get(cur).text, m = new RegExp('(^|\\s)\\^' + id.replace(/[^\w-]/g, '') + '[ \\t]*$', 'm').exec(t); if (!m) return;
  if (preview) { const el = $('#pv')?.querySelector(`[data-blk="${CSS.escape(id)}"]`); if (el) $('#pane').scrollTop += el.getBoundingClientRect().top - $('#pane').getBoundingClientRect().top - 12; return; }
  const ed = $('#ed'); if (!ed) return;
  ed.focus(); ed.setSelectionRange(m.index, m.index); caretIntoView(true);
}
function updateWC() {
  const t = cur && notes.get(cur) ? notes.get(cur).text : null, el = $('#wc');
  if (t == null || graphOn) { el.textContent = ''; return; }
  const w = (t.match(/\S+/g) || []).length;
  el.textContent = `${w.toLocaleString()} word${w === 1 ? '' : 's'} · ${t.length.toLocaleString()} chars`;
}
function renderPane() {
  if (cur && tabs[ti]) { tabs[ti].preview = preview; saveTabs(); }
  updateWC(); renderPin(); renderOutline(); renderProps(true);
  $('#tog').disabled = $('#del').disabled = !cur;
  if (graphOn) return drawGraph();
  stopGraph(); setIcon('#gr', 'graph', 'Graph view'); $('#gr').title = 'Graph view (Ctrl/Cmd+G)';
  if (!cur) { $('#pane').innerHTML = '<div class="empty">Ctrl/Cmd+K to jump or create · Ctrl/Cmd+N for a new note · Ctrl/Cmd+E to preview</div>'; return; }
  const t = notes.get(cur).text;
  setIcon('#tog', preview ? 'pencil' : 'eye', preview ? 'Edit' : 'Preview');
  if (preview) $('#pane').innerHTML = `<div id="pv">${md(t)}</div>`;
  else { $('#pane').innerHTML = '<div id="edwrap"><pre id="hl" aria-hidden="true"></pre><textarea id="ed" spellcheck="false" placeholder="Start writing… use [[links]] to connect notes"></textarea></div>';
    const ed = $('#ed'); ed.value = t; syncEditor(); ed.oninput = () => { onInput(); acUpdate(); caretIntoView(); }; ed.onkeydown = (e) => { edKey(e); setTimeout(caretIntoView, 0); }; ed.onblur = () => setTimeout(acHide, 150);
    ed.onpaste = (e) => { if (attach(e.clipboardData.files)) { if ([...e.clipboardData.files].some((f) => f.type.startsWith('image/'))) e.preventDefault(); } };
    ed.ondragover = (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) e.preventDefault(); };
    ed.ondrop = (e) => { if ([...e.dataTransfer.files].some((f) => f.type.startsWith('image/'))) { e.preventDefault(); attach(e.dataTransfer.files); } }; if (!t) ed.focus(); }
}
/* ---------- split: a live, read-only preview of a second note beside the main pane ---------- */
let split = null, splitTimer = 0; try { split = localStorage.getItem('split') || null; } catch {}
function renderSplit() {
  const el = $('#split'), n = split && notes.get(split);
  if (!n) { if (split) { split = null; try { localStorage.removeItem('split'); } catch {} } el.style.display = 'none'; return; }
  el.style.display = 'flex'; $('#sptitle').textContent = n.name.split('/').pop(); $('#sptitle').title = `Open “${n.name}” in the main pane`;
  const pv = $('#sppv'), top = pv.scrollTop;
  pv.innerHTML = md(n.text); pv.scrollTop = top;
}
const renderSplitSoon = () => { clearTimeout(splitTimer); splitTimer = setTimeout(renderSplit, 250); };
function openSplit(name) { if (!notes.has(name)) return; split = name; try { localStorage.setItem('split', name); } catch {} renderSplit(); }
function closeSplit() { split = null; try { localStorage.removeItem('split'); } catch {} renderSplit(); }
$('#spx').onclick = closeSplit;
$('#sptitle').onclick = () => { if (split) open(split, false); };

/* ---------- tabs: each tab shows one note; the active tab's note is `cur` ---------- */
let tabs = [{ name: null, preview: false }], ti = 0, pendingPreview = false;
const saveTabs = () => { try { localStorage.setItem('tabs', JSON.stringify({ i: ti, tabs: tabs.map((t) => ({ name: t.name, preview: !!t.preview })) })); } catch {} };
function renderTabs() {
  const el = $('#tabs'); el.style.display = tabs.length > 1 ? 'flex' : 'none';
  el.innerHTML = tabs.map((t, i) => `<div class="tab${i === ti ? ' on' : ''}" role="tab" aria-selected="${i === ti}" data-tab="${i}" title="${esc(t.name || 'New tab')}"><span>${esc(t.name ? t.name.split('/').pop() : 'New tab')}</span><button class="x" data-tabclose="${i}" aria-label="Close tab" title="Close tab">×</button></div>`).join('')
    + '<button id="newtab" title="New tab (Ctrl/Cmd+T)" aria-label="New tab">+</button>';
}
function showEmpty() {
  cur = null; dirty = false; preview = false; $('#status').textContent = ''; $('#title').value = ''; $('#title').disabled = true;
  location.hash = ''; renderList(); renderPane(); renderBack();
}
async function openInNewTab(name, create) {
  await flush(); tabs.splice(ti + 1, 0, { name: null, preview: false }); ti++;
  await open(name, create);
  if (tabs[ti] && !tabs[ti].name) await closeTab(ti);           // the note did not exist
  renderTabs(); saveTabs();
}
async function newTab() { await flush(); tabs.splice(ti + 1, 0, { name: null, preview: false }); ti++; showEmpty(); renderTabs(); saveTabs(); swOpen(); }
async function switchTab(i) {
  if (i === ti || !tabs[i]) return; await flush();
  ti = i; const t = tabs[i]; pendingPreview = !!t.preview;
  if (t.name && notes.has(t.name)) await open(t.name, false); else showEmpty();
  renderTabs(); saveTabs();
}
async function closeTab(i = ti) {
  if (!tabs[i]) return; await flush();
  if (tabs.length === 1) { tabs[0] = { name: null, preview: false }; ti = 0; showEmpty(); renderTabs(); saveTabs(); return; }
  tabs.splice(i, 1);
  if (i < ti) ti--;
  else if (i === ti) { ti = Math.min(i, tabs.length - 1); const t = tabs[ti]; pendingPreview = !!t.preview; if (t.name && notes.has(t.name)) await open(t.name, false); else showEmpty(); }
  renderTabs(); saveTabs();
}
const closeTabCmd = () => (tabs.length === 1 && !tabs[0].name ? macPost({ t: 'closewindow' }) : closeTab());
const stepTab = (d) => switchTab((ti + d + tabs.length) % tabs.length);
async function open(name, create) {
  await flush();
  name = name.trim().replace(/^\/+|\.md$/gi, '');
  if (!name) return;
  if (!notes.has(name)) {
    if (!create) return;
    try {
      const r = await api('/api/note?name=' + encodeURIComponent(name), { method: 'PUT', body: '', headers: { 'x-base-mtime': '0' } });
      notes.set(name, { name, text: '', mtime: Date.now(), base: r.mtime });
    } catch (e) { await load(); if (!notes.has(name)) return; }
  }
  document.body.classList.remove('side-open');
  if (name.includes('/')) { const d = name.slice(0, name.lastIndexOf('/')); for (let i = d.indexOf('/'); i >= 0; i = d.indexOf('/', i + 1)) openFolders.add(d.slice(0, i)); openFolders.add(d); saveOpenFolders(); }
  addingProp = false; cur = name; preview = pendingPreview; pendingPreview = false; graphOn = false; tabs[ti].name = name; renderTabs(); location.hash = encodeURIComponent(name);
  try { localStorage.setItem('last', name); } catch {}
  const t = $('#title'); t.disabled = false; t.value = name.split('/').pop();
  renderPane(); renderList(); renderBack(); $('#status').textContent = '';
  if (!notes.get(name).text) $('#ed').focus();
}
/* ---------- editor helpers ---------- */
function applyEdit(ed, x) {
  ed.focus(); ed.setSelectionRange(x.start, x.end);
  if (!document.execCommand('insertText', false, x.insert)) ed.setRangeText(x.insert, x.start, x.end, 'end');   // execCommand keeps native undo
  ed.setSelectionRange(x.selStart, x.selEnd); onInput();
}
let acRows = [], acSel = 0;
const acHide = () => { acRows = []; $('#ac').style.display = 'none'; };
function acUpdate() {
  const ed = $('#ed'); if (!ed) return;
  const sl = MD.slashContext(ed.value, ed.selectionStart), c = sl ? null : MD.wikiContext(ed.value, ed.selectionStart);
  if (!sl && !c) return acHide();
  if (sl) acRows = MD.slashItems(sl.query);
  else if (c.query.includes('#')) {                                              // [[Note#… -> that note's headings
    const [nm, hq] = [c.query.slice(0, c.query.indexOf('#')), c.query.slice(c.query.indexOf('#') + 1).toLowerCase()], target = nm ? resolve(nm) : cur;
    acRows = target ? headingsOf(notes.get(target).text).map((h) => `${nm || ''}#${h.text.replace(/[*_`]/g, '')}`).filter((r) => r.slice(r.indexOf('#') + 1).toLowerCase().includes(hq)).slice(0, 8) : [];
  } else { const q = c.query.toLowerCase();
    acRows = [...notes.keys()].filter((n) => n !== cur && n.toLowerCase().includes(q)).sort((a, b) => a.length - b.length).slice(0, 6); }
  acSel = Math.min(acSel, Math.max(0, acRows.length - 1));
  const box = $('#ac');
  if (!acRows.length) return acHide();
  box.innerHTML = acRows.map((n, i) => `<div class="item${i === acSel ? ' on' : ''}" data-ac="${i}">${esc(typeof n === 'string' ? n : n.label)}</div>`).join('');
  box.style.display = 'block';
}
function acPick(i) {
  const ed = $('#ed'), sl = MD.slashContext(ed.value, ed.selectionStart);
  if (sl && acRows[i] && typeof acRows[i] === 'object') {                       // slash menu: replace "/query" with the block
    const it = acRows[i], at = sl.start + it.caret;
    acHide(); applyEdit(ed, { start: sl.start, end: ed.selectionStart, insert: it.text, selStart: at, selEnd: at }); acUpdate(); return;
  }
  const c = MD.wikiContext(ed.value, ed.selectionStart), name = acRows[i];
  if (!c || !name) return;
  const after = ed.value.slice(ed.selectionStart, ed.selectionStart + 2) === ']]' ? 2 : 0;
  const end = ed.selectionStart + after, ins = name + ']]', at = c.start + ins.length;
  acHide(); applyEdit(ed, { start: c.start, end, insert: ins, selStart: at, selEnd: at });
}
$('#ac').onmousedown = (e) => { const r = e.target.closest('[data-ac]'); if (r) { e.preventDefault(); acPick(+r.dataset.ac); } };
function edKey(e) {
  const ed = e.target, v = ed.value, s = ed.selectionStart, en = ed.selectionEnd, mod = e.metaKey || e.ctrlKey;
  if (acRows.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); acSel = (acSel + 1) % acRows.length; return acUpdate(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); acSel = (acSel + acRows.length - 1) % acRows.length; return acUpdate(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return acPick(acSel); }
    if (e.key === 'Escape') { e.preventDefault(); return acHide(); }
  }
  if (e.key === 'Enter' && !mod && !e.shiftKey && s === en) {
    const x = MD.listEnter(v, s); if (x) { e.preventDefault(); applyEdit(ed, x); }
  } else if (e.key === 'Tab' && !mod) {
    e.preventDefault(); applyEdit(ed, MD.indentLines(v, s, en, e.shiftKey));
  } else if (mod && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'i')) {
    e.preventDefault(); applyEdit(ed, MD.wrap(v, s, en, e.key === 'b' ? '**' : '*'));
  }
}

async function attach(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return false;
  const ed = $('#ed');
  for (const f of imgs) {
    try {
      const r = await api('/api/upload?name=' + encodeURIComponent(f.name || 'image.' + (f.type.split('/')[1] || 'png').replace('svg+xml', 'svg')), { method: 'POST', body: f });
      const md = `![${(f.name || '').replace(/\.\w+$/, '').replace(/[\[\]]/g, '')}](${r.path})\n`;
      const a = ed.selectionStart; ed.setRangeText(md, a, ed.selectionEnd, 'end');
    } catch (e) { $('#status').textContent = 'Upload failed: ' + e.message; }
  }
  onInput(); return true;
}
const HL_LIMIT = 300000;        // beyond this, skip highlighting to keep typing instant
function syncEditor() {
  const ed = $('#ed'), hl = $('#hl'), wrap = $('#edwrap'), pane = $('#pane');
  if (!ed || !hl) return;
  hl.innerHTML = ed.value.length > HL_LIMIT ? esc(ed.value) + '\n' : MD.highlightMarkdown(ed.value) + '\n';   // trailing \n keeps the last empty line's height
  wrap.style.minHeight = pane.clientHeight + 'px';
  ed.style.height = 'auto';
  ed.style.height = Math.max(ed.scrollHeight, pane.clientHeight) + 'px';       // grow with content; the pane scrolls
  if (typeof frOpen === 'function' && frOpen()) frUpdate();
}
new ResizeObserver(() => syncEditor()).observe($('#pane'));
// The textarea grows with its content (so it lines up with the highlight layer), so the pane scrolls instead:
// find the caret's on-screen position via the mirror and keep it in view.
function caretIntoView(top) {
  const ed = $('#ed'), hl = $('#hl'), pane = $('#pane');
  if (!ed || !hl) return;
  const off = ed.selectionEnd, w = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
  let n, pos = 0, node = null, at = 0;
  while ((n = w.nextNode())) { const l = n.nodeValue.length; if (pos + l >= off) { node = n; at = off - pos; break; } pos += l; }
  if (!node) return;
  const r = document.createRange(); r.setStart(node, at); r.setEnd(node, Math.min(at + 1, node.nodeValue.length));
  let rect = r.getBoundingClientRect();
  if (!rect.height) { r.setStart(node, Math.max(0, at - 1)); r.setEnd(node, at); rect = r.getBoundingClientRect(); }
  if (!rect.height) return;
  const pr = pane.getBoundingClientRect();
  if (document.body.classList.contains('focus') && !top) pane.scrollTop += rect.top - pr.top - pr.height * 0.45;   // typewriter scrolling
  else if (top) pane.scrollTop += rect.top - pr.top - 12;   // put the caret line at the top
  else if (rect.bottom > pr.bottom - 24) pane.scrollTop += rect.bottom - pr.bottom + 56;
  else if (rect.top < pr.top + 8) pane.scrollTop -= pr.top - rect.top + 56;
}
function onInput() {
  syncEditor();
  const n = notes.get(cur); n.text = $('#ed').value; n.mtime = Date.now(); aliasMap = null; dirty = true; updateWC(); renderOutline(); renderProps(); if (split && split === cur) renderSplitSoon();
  $('#status').textContent = 'Editing…'; clearTimeout(timer); timer = setTimeout(flush, 600);
}
async function flush() {
  clearTimeout(timer);
  if (!dirty || !cur) return;
  dirty = false;
  const name = cur, n = notes.get(name), text = n.text;
  try {
    const r = await api('/api/note?name=' + encodeURIComponent(name), { method: 'PUT', body: text, headers: { 'x-base-mtime': String(n.base ?? 0) } });
    n.base = r.mtime; $('#status').textContent = 'Saved'; renderList();
  } catch (e) {
    if (e.message !== 'conflict') { dirty = true; $('#status').textContent = 'Save failed: ' + e.message; return; }
    // The file changed on disk (sync, another window…). Keep both versions: ours as a conflict copy.
    const copy = `${name} (conflict ${new Date().toTimeString().slice(0, 8).replace(/:/g, '-')})`;
    try { await api('/api/note?name=' + encodeURIComponent(copy), { method: 'PUT', body: text }); } catch {}
    const was = cur; await load();
    if (was === name && notes.has(name)) { cur = name; renderPane(); renderBack(); }
    $('#status').textContent = `Changed elsewhere — your version saved as “${copy}”`;
  }
}
async function newNote() {
  let i = 0, n; do { n = i ? `Untitled ${i}` : 'Untitled'; i++; } while (notes.has(n));
  await open(n, true);
}
/* templates: notes in templates/ ({{date}} {{time}} {{title}} get filled in) */
function applyTemplate(tpl) {
  const n = notes.get(cur), t = notes.get(tpl); if (!n || !t) return;
  n.text = MD.fillTemplate(t.text, cur.split('/').pop());
  preview = false; renderPane(); renderList(); onInput();
}
async function newFromTemplate(tpl, name) {
  let i = 0, n = name; if (!n) do { n = i ? `Untitled ${i}` : 'Untitled'; i++; } while (notes.has(n));
  await open(n, true); applyTemplate(tpl);
}
async function addStarterTemplates() {
  const T = { 'templates/Daily': '# {{date}}\n\n## Plan\n- [ ] \n\n## Notes\n\n', 'templates/Meeting': '# {{title}}\n{{date}}\n\n**Attendees:** \n\n## Agenda\n- \n\n## Decisions\n\n## Action items\n- [ ] \n',
    'templates/Project': '# {{title}}\nCreated {{date}} #project\n\n## Goal\n\n## Milestones\n- [ ] \n\n## Notes\n' };
  for (const [name, text] of Object.entries(T)) if (!notes.has(name)) await api('/api/note?name=' + encodeURIComponent(name), { method: 'PUT', body: text, headers: { 'x-base-mtime': '0' } }).catch(() => {});
  await load(); renderList(); $('#status').textContent = 'Templates added: use “New note from template” in the palette (Daily is used for new daily notes)';
}

/* focus mode */
function toggleFocus() { document.body.classList.toggle('focus'); renderPane(); if ($('#ed')) $('#ed').focus(); }

/* find and replace in the open note: matches are painted with the CSS Custom Highlight API over the highlight mirror */
let frIdx = 0;
function frOpen() { return $('#fr').classList.contains('on'); }
function frRange(start, end) {                      // DOM range over #hl's text for [start, end)
  const w = document.createTreeWalker($('#hl'), NodeFilter.SHOW_TEXT); let n, pos = 0, r = document.createRange(), a = false;
  while ((n = w.nextNode())) { const l = n.nodeValue.length;
    if (!a && start <= pos + l) { r.setStart(n, start - pos); a = true; }
    if (a && end <= pos + l) { r.setEnd(n, end - pos); return r; }
    pos += l; }
  return a ? r : null;
}
function frUpdate(scroll) {
  const ed = $('#ed'), q = $('#frq').value, ms = ed ? MD.findAll(ed.value, q) : [];
  frIdx = ms.length ? Math.min(Math.max(frIdx, 0), ms.length - 1) : 0;
  $('#frc').textContent = !q ? '' : ms.length ? `${frIdx + 1} of ${ms.length}` : 'No matches';
  if (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') {
    CSS.highlights.delete('find'); CSS.highlights.delete('findcur');
    if (ed && ms.length) {
      CSS.highlights.set('find', new Highlight(...ms.map((m) => frRange(m.start, m.end)).filter(Boolean)));
      const cr = frRange(ms[frIdx].start, ms[frIdx].end); if (cr) CSS.highlights.set('findcur', new Highlight(cr));
    }
  }
  if (scroll && ms.length) {
    const rect = frRange(ms[frIdx].start, ms[frIdx].end)?.getBoundingClientRect(), pane = $('#pane'), pr = pane.getBoundingClientRect();
    if (rect && (rect.top < pr.top + 20 || rect.bottom > pr.bottom - 20)) pane.scrollTop += rect.top - pr.top - pr.height / 3;
  }
  return ms;
}
function frStep(dir) { const ms = frUpdate(); if (!ms.length) return; frIdx = (frIdx + dir + ms.length) % ms.length; frUpdate(true); }
function openFind() {
  if (!$('#ed')) { if (cur && preview) { preview = false; renderPane(); } if (!$('#ed')) return; }
  const ed = $('#ed'), sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
  $('#fr').classList.add('on'); if (sel && !sel.includes('\n')) $('#frq').value = sel;
  frIdx = 0; frUpdate(true); $('#frq').focus(); $('#frq').select();
}
function closeFind() {
  $('#fr').classList.remove('on');
  if (window.CSS && CSS.highlights) { CSS.highlights.delete('find'); CSS.highlights.delete('findcur'); }
  $('#ed')?.focus();
}
function frReplace(all) {
  const ed = $('#ed'); if (!ed) return; const q = $('#frq').value, r = $('#frr').value, ms = MD.findAll(ed.value, q); if (!ms.length) return;
  if (all) {
    let out = '', at = 0; for (const m of ms) { out += ed.value.slice(at, m.start) + r; at = m.end; } out += ed.value.slice(at);
    applyEdit(ed, { start: 0, end: ed.value.length, insert: out, selStart: 0, selEnd: 0 });
    $('#frc').textContent = `Replaced ${ms.length}`; $('#frr').focus(); return;
  }
  const m = ms[Math.min(frIdx, ms.length - 1)];
  applyEdit(ed, { start: m.start, end: m.end, insert: r, selStart: m.start + r.length, selEnd: m.start + r.length });
  const left = MD.findAll(ed.value, q); frIdx = Math.max(0, left.findIndex((x) => x.start >= m.start + r.length)); if (left.length && left.every((x) => x.start < m.start + r.length)) frIdx = 0;
  frUpdate(true); $('#frr').focus();
}
$('#frq').oninput = () => { frIdx = 0; frUpdate(true); };
$('#frq').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); frStep(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); } };
$('#frr').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); frReplace(false); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); } };
$('#frn').onclick = () => frStep(1); $('#frp').onclick = () => frStep(-1);
$('#frs').onclick = () => frReplace(false); $('#fra').onclick = () => frReplace(true); $('#frx').onclick = closeFind;

async function openToday() {
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  const name = `daily/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const fresh = !notes.has(name);
  await open(name, fresh);
  if (fresh && notes.has('templates/Daily') && !notes.get(name).text) applyTemplate('templates/Daily');
}
/* export: the rendered note as one self-contained .html file (page styles are reused, so it matches the preview) */
function exportHtml() {
  if (!cur) return;
  const css = [];
  for (const sh of document.styleSheets) for (const r of sh.cssRules) {
    const t = r.cssText;
    if (/^(:root|html|\*|#pv|\.tk-|@media \(prefers-color-scheme)/.test(t) && !/#(app|side|bar|hl|ed)\b/.test(t)) css.push(t);
  }
  const doc = new DOMParser().parseFromString(`<div id="pv">${md(notes.get(cur).text)}</div>`, 'text/html');
  for (const a of doc.querySelectorAll('[data-note],[data-tag]')) { const sp = doc.createElement('span'); sp.className = a.className; sp.innerHTML = a.innerHTML; a.replaceWith(sp); }
  for (const im of doc.querySelectorAll('img')) { const src = im.getAttribute('src') || ''; if (src.startsWith('/')) im.setAttribute('src', location.origin + src); }
  const title = cur.split('/').pop();
  const html = `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>\n<style>\n${css.join('\n')}\n</style></head>\n<body>${doc.body.innerHTML}</body></html>\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); a.download = title + '.html';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// Move/rename a note on disk and keep everything that points at it working (links, pins, the open note).
async function renameNote(from, to) {
  await flush();
  try { await api('/api/rename', { method: 'POST', body: JSON.stringify({ from, to }) }); }
  catch (e) { $('#status').textContent = 'Rename failed: ' + (e.message === 'exists' ? 'a note with that name already exists' : e.message); return false; }
  const n = notes.get(from); notes.delete(from); n.name = to; notes.set(to, n); aliasMap = null;
  tabs.forEach((t) => { if (t.name === from) t.name = to; }); renderTabs(); saveTabs();
  if (split === from) { split = to; try { localStorage.setItem('split', to); } catch {} renderSplit(); }
  const re = new RegExp(`\\[\\[(\\s*)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*)(?=[|\\]#^])`, 'g');
  for (const o of notes.values()) if (o.text.match(re)) {            // keep links working, including [[Note#Heading]] and [[Note^id]]
    o.text = o.text.replace(re, `[[$1${to}$2`);
    api('/api/note?name=' + encodeURIComponent(o.name), { method: 'PUT', body: o.text }).then((r) => { o.base = r.mtime; }, () => {}); }
  if (pins.delete(from)) { pins.add(to); savePins(); }
  if (to.includes('/')) { const d = to.slice(0, to.lastIndexOf('/')); for (let i = d.indexOf('/'); i >= 0; i = d.indexOf('/', i + 1)) openFolders.add(d.slice(0, i)); openFolders.add(d); saveOpenFolders(); }
  if (cur === from) { cur = to; location.hash = encodeURIComponent(to); $('#title').value = to.split('/').pop(); }
  renderList(); renderBack(); if (cur === to) renderPane();
  return true;
}
async function rename() {
  const to = $('#title').value.trim().replace(/[\\:*?"<>|]/g, '');
  const dir = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/') + 1) : '';
  const full = dir + to;
  if (!to || full === cur) { $('#title').value = cur.split('/').pop(); return; }
  if (!(await renameNote(cur, full))) $('#title').value = cur.split('/').pop();
}
const moveNote = (name, folder) => renameNote(name, (folder ? folder + '/' : '') + name.split('/').pop());

/* ---------- Graph ---------- */
function stopGraph() { cancelAnimationFrame(gRaf); gRaf = 0; }
function drawGraph() {
  stopGraph();
  setIcon('#gr', 'x', 'Close graph'); $('#gr').title = 'Close graph (Ctrl/Cmd+G)';
  const pane = $('#pane');
  pane.innerHTML = '<canvas id="gc"></canvas><div id="gmode" title="Click to change: all notes / this note and its links / two steps out"></div>';
  const cv = $('#gc'), ctx = cv.getContext('2d'), dpr = devicePixelRatio || 1;
  const ids = new Map(), nodes = [], links = [];
  const node = (id, label, ghost) => { let n = ids.get(id);
    if (!n) { const a = Math.random() * 6.28, d = 40 + Math.random() * 120;
      n = { id, label, ghost, x: Math.cos(a) * d, y: Math.sin(a) * d, vx: 0, vy: 0, deg: 0 }; ids.set(id, n); nodes.push(n); } return n; };
  for (const name of notes.keys()) node(name, name.split('/').pop(), false);
  for (const o of notes.values()) {
    const seen = new Set();
    for (const m of o.text.matchAll(linkRe)) {
      const r = resolveLink(m[1]), key = r || m[1].trim().toLowerCase();
      if (key === o.name || seen.has(key)) continue; seen.add(key);
      const t = node(key, r ? r.split('/').pop() : m[1].trim(), !r), s = ids.get(o.name);
      links.push([s, t]); s.deg++; t.deg++;
    } }
  if (graphScope && cur && ids.has(cur)) {           // keep only notes within graphScope links of the open note
    const dist = new Map([[cur, 0]]), q = [cur];
    while (q.length) { const id = q.shift(), d = dist.get(id); if (d >= graphScope) continue;
      for (const [a, b] of links) { const o = a.id === id ? b.id : b.id === id ? a.id : null; if (o && !dist.has(o)) { dist.set(o, d + 1); q.push(o); } } }
    for (let i = nodes.length - 1; i >= 0; i--) if (!dist.has(nodes[i].id)) nodes.splice(i, 1);
    for (let i = links.length - 1; i >= 0; i--) if (!dist.has(links[i][0].id) || !dist.has(links[i][1].id)) links.splice(i, 1);
    for (const n of nodes) { n.deg = 0; n.x *= 0.3; n.y *= 0.3; }
    for (const [a, b] of links) { a.deg++; b.deg++; }
  } else if (graphScope) graphScope = 0;
  $('#gmode').textContent = graphScope ? `Around “${cur.split('/').pop()}” · ${graphScope === 1 ? '1 step' : '2 steps'}` : 'All notes';
  $('#gmode').onclick = () => { graphScope = cur ? (graphScope + 1) % 3 : 0; drawGraph(); };
  if (!nodes.length) { pane.innerHTML = '<div class="empty">No notes yet</div>'; return; }
  cv.dataset.nodes = nodes.length;
  const css = getComputedStyle(document.documentElement), C = (v) => css.getPropertyValue(v).trim();
  let userView = false, frames = 0, W, H, scale = 1, ox = 0, oy = 0, alpha = 1, drag = null, pan = null, hover = null, moved = false;
  const size = () => { W = pane.clientWidth; H = pane.clientHeight; cv.width = W * dpr; cv.height = H * dpr; };
  size(); const ro = new ResizeObserver(() => { if (cv.isConnected) size(); else ro.disconnect(); }); ro.observe(pane);
  const rad = (n) => 4 + Math.sqrt(n.deg) * 3;
  const toW = (px, py) => [(px - W / 2 - ox) / scale, (py - H / 2 - oy) / scale];
  const pick = (px, py) => { const [x, y] = toW(px, py); let best = null, bd = 1e9;
    for (const n of nodes) { const d = Math.hypot(n.x - x, n.y - y); if (d < rad(n) + 4 / scale && d < bd) { best = n; bd = d; } } return best; };

  function step() {
    const N = nodes.length;
    for (let i = 0; i < N; i++) { const a = nodes[i];
      for (let j = i + 1; j < N; j++) { const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 90000) continue;
        const f = Math.min(1800 / d2, 30), d = Math.sqrt(d2);   // capped so overlapping nodes can't be flung away
        dx = dx / d * f; dy = dy / d * f;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy; } }
    for (const [a, b] of links) { const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = (d - 70) * 0.02;
      a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; }
    for (const n of nodes) { n.vx -= n.x * 0.004; n.vy -= n.y * 0.004;
      if (n === drag) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx * alpha; n.y += n.vy * alpha; }
    alpha = Math.max(alpha * 0.994, 0.02);
    if (!userView && frames++ < 400) {                       // ease the view to fit the whole graph until the user takes over
      let mx = 1, my = 1; for (const n of nodes) { mx = Math.max(mx, Math.abs(n.x)); my = Math.max(my, Math.abs(n.y)); }
      const target = Math.min(2.2, Math.max(0.3, Math.min((W / 2 - 70) / mx, (H / 2 - 50) / my)));
      scale += (target - scale) * 0.06; ox *= 0.9; oy *= 0.9;
    }
  }
  function paint() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.translate(W / 2 + ox, H / 2 + oy); ctx.scale(scale, scale);
    const hot = new Set(); if (hover) { hot.add(hover); for (const [a, b] of links) { if (a === hover) hot.add(b); if (b === hover) hot.add(a); } }
    ctx.lineWidth = 1 / scale;
    for (const [a, b] of links) { const on = hover && (a === hover || b === hover);
      ctx.strokeStyle = on ? C('--acc') : C('--line'); ctx.globalAlpha = hover && !on ? 0.3 : 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    ctx.font = `${12 / scale}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'center';
    for (const n of nodes) {
      const dim = hover && !hot.has(n), isCur = n.id === cur;
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = isCur ? C('--acc') : n.ghost ? C('--line') : C('--mute');
      ctx.beginPath(); ctx.arc(n.x, n.y, rad(n), 0, 6.283); ctx.fill();
      if (isCur) { ctx.strokeStyle = C('--acc'); ctx.beginPath(); ctx.arc(n.x, n.y, rad(n) + 3 / scale, 0, 6.283); ctx.stroke(); }
      if (scale > 0.6 || hot.has(n) || isCur) { ctx.fillStyle = C('--fg'); ctx.fillText(n.label, n.x, n.y + rad(n) + 13 / scale); } }
    ctx.globalAlpha = 1;
  }
  const loop = () => { if (!cv.isConnected) return; step(); paint(); gRaf = requestAnimationFrame(loop); };
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.onpointerdown = (e) => { const [px, py] = pos(e); cv.setPointerCapture(e.pointerId); moved = false; userView = true;
    const n = pick(px, py); if (n) drag = n; else { pan = [px - ox, py - oy]; } cv.style.cursor = 'grabbing'; };
  cv.onpointermove = (e) => { const [px, py] = pos(e);
    if (drag) { [drag.x, drag.y] = toW(px, py); alpha = 0.6; moved = true; }
    else if (pan) { ox = px - pan[0]; oy = py - pan[1]; moved = true; }
    else { const h = pick(px, py); if (h !== hover) { hover = h; cv.style.cursor = h ? 'pointer' : 'grab'; } } };
  cv.onpointerup = () => { if (drag && !moved) { const n = drag; drag = null; graphOn = false; open(n.id, true); return; }
    drag = pan = null; cv.style.cursor = hover ? 'pointer' : 'grab'; };
  cv.onwheel = (e) => { e.preventDefault(); userView = true; const [px, py] = pos(e), k = Math.exp(-e.deltaY * 0.0015), ns = Math.min(4, Math.max(0.2, scale * k));
    const [wx, wy] = toW(px, py); scale = ns; ox = px - W / 2 - wx * scale; oy = py - H / 2 - wy * scale; };
  if (/[?&]settle\b/.test(location.search)) for (let i = 0; i < 600; i++) step();   // ?graph&settle: pre-computed layout (deterministic screenshots)
  loop();
}

/* quick switcher */
let swSel = 0, swRows = [];
/* command palette: same overlay as the switcher, listing actions instead of notes (Ctrl/Cmd+Shift+P) */
let swMode = 'notes';
const COMMANDS = [
  { id: 'new', name: 'New note', hint: 'Ctrl/Cmd+N', run: () => newNote() },
  { id: 'today', name: 'Open today’s daily note', hint: 'Ctrl/Cmd+Shift+T', run: () => openToday() },
  { id: 'toggle', name: 'Toggle edit / preview', hint: 'Ctrl/Cmd+E', run: () => $('#tog').click() },
  { id: 'graph', name: 'Toggle graph view', hint: 'Ctrl/Cmd+G', run: () => $('#gr').click() },
  { id: 'localgraph', name: 'Graph of this note and its links', run: async () => { if (!cur) return; await flush(); graphScope = 1; graphOn = true; renderPane(); } },
  { id: 'pin', name: 'Pin / unpin this note', run: () => $('#pin').click() },
  { id: 'pdf', name: 'Export this note as PDF / Print…', run: () => exportPdf() },
  { id: 'gfind', name: 'Find and replace in all notes', hint: 'Ctrl/Cmd+Shift+H', run: () => openGlobalFind() },
  { id: 'export', name: 'Export this note as HTML', run: () => exportHtml() },
  { id: 'theme', name: 'Cycle theme (auto / light / dark)', hint: 'Ctrl/Cmd+Shift+L', run: () => $('#theme').click() },
  { id: 'bigger', name: 'Larger text', hint: 'Ctrl/Cmd +', run: () => setFontSize(fontSize + 1, true) },
  { id: 'smaller', name: 'Smaller text', hint: 'Ctrl/Cmd −', run: () => setFontSize(fontSize - 1, true) },
  { id: 'reset', name: 'Reset text size', hint: 'Ctrl/Cmd 0', run: () => setFontSize(14, true) },
  { id: 'sync', name: 'Sync now', run: () => $('#sync').click() },
  { id: 'trash', name: 'Show trash', run: () => $('#trash').click() },
  { id: 'focus', name: 'Toggle focus mode', hint: 'Ctrl/Cmd+Shift+F', run: () => toggleFocus() },
  { id: 'tasks', name: 'Show open tasks from all notes', run: () => swOpen('tasks') },
  { id: 'find', name: 'Find and replace in this note', hint: 'Ctrl/Cmd+F', run: () => openFind() },
  { id: 'starter', name: 'Add starter templates (Daily, Meeting, Project)', run: () => addStarterTemplates() },
  { id: 'splitcur', name: 'Open this note in a split pane to the right', hint: 'Ctrl/Cmd+Alt+\\', run: () => cur && openSplit(cur) },
  { id: 'splitclose', name: 'Close the split pane', run: () => closeSplit() },
  { id: 'newtab', name: 'New tab', hint: 'Ctrl/Cmd+T', run: () => newTab() },
  { id: 'closetab', name: 'Close tab', hint: 'Ctrl/Cmd+W', run: () => closeTabCmd() },
  { id: 'nexttab', name: 'Next tab', hint: 'Ctrl/Cmd+Shift+]', run: () => stepTab(1) },
  { id: 'prevtab', name: 'Previous tab', hint: 'Ctrl/Cmd+Shift+[', run: () => stepTab(-1) },
  { id: 'back', name: 'Go back', hint: 'Ctrl/Cmd+[', run: () => history.back() },
  { id: 'forward', name: 'Go forward', hint: 'Ctrl/Cmd+]', run: () => history.forward() },
];
/* bridge for the native Mac app (menus call plainnote.run('<id>')); also handy for tests */
const EXTRA = {
  palette: () => swOpen('cmds'), switcher: () => swOpen(),
  sidebar: () => { const off = document.body.classList.toggle('side-off'); try { off ? localStorage.setItem('sideOff', '1') : localStorage.removeItem('sideOff'); } catch {} reportSide(); },
};
try { if (localStorage.getItem('sideOff')) document.body.classList.add('side-off'); } catch {}
window.plainnote = {
  ready: null,                                                      // resolves once the first load finished (the app waits on it)
  async run(id) { await this.ready; const c = COMMANDS.find((x) => x.id === id); (c ? c.run : EXTRA[id])?.(); },
  async openNote(name, create) { await this.ready; await load(); await open(name, !!create); },   // reload first: the note may have just been written on disk
  setInset(px) { if (px >= 0 && px < 200) document.documentElement.style.setProperty('--tb', px + 'px'); },   // toolbar height from AppKit
  setAccent(hex) {                                                  // the Mac app passes the system accent colour
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)), st = document.documentElement.style;
    st.setProperty('--acc', hex); st.setProperty('--sel', hex + '44');
    st.setProperty('--on-acc', (0.299 * r + 0.587 * g + 0.114 * b) > 170 ? '#000' : '#fff');
  },
  current: () => (cur && notes.get(cur) ? { name: cur, text: notes.get(cur).text } : null),
};
const setBlur = () => document.documentElement.classList.toggle('blur', !document.hasFocus());
window.addEventListener('focus', setBlur); window.addEventListener('blur', setBlur);
const macPost = (m) => { try { window.webkit?.messageHandlers?.mac?.postMessage(m); } catch {} };
if (/[?&]mac\b/.test(location.search)) document.documentElement.classList.add('mac');   // ?mac previews the native-app layout in a browser
function reportSide() { const sd = $('#side'); macPost({ t: 'side', w: getComputedStyle(sd).display === 'none' ? 0 : Math.round(sd.getBoundingClientRect().width) }); }
new ResizeObserver(reportSide).observe($('#side'));
document.addEventListener('mousedown', (e) => {                       // the title bar is web content in the Mac app: drag the window from empty bar space
  if (!document.documentElement.classList.contains('mac') || e.button !== 0 || e.target.closest('button,input,a,select,label,textarea,canvas,.item,.chip')) return;
  if (e.target.closest('#bar, #side header, #sf')) macPost({ t: 'drag' });
});
document.addEventListener('dblclick', (e) => {
  if (document.documentElement.classList.contains('mac') && e.target.closest('#bar, #side header') && !e.target.closest('button,input,a,label')) macPost({ t: 'zoom' });
});
/* global find & replace: preview every affected note first, tick the ones to change */
let gfHits = [];
function gfRender() {
  const q = $('#gfq').value;
  gfHits = q ? [...notes.values()].map((n) => ({ name: n.name, hits: MD.findAll(n.text, q), text: n.text })).filter((h) => h.hits.length).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const total = gfHits.reduce((a, h) => a + h.hits.length, 0);
  $('#gfl').innerHTML = gfHits.map((h, i) => {
    const m = h.hits[0], a = Math.max(0, m.start - 30), snip = esc(h.text.slice(a, m.start)) + '<mark>' + esc(h.text.slice(m.start, m.end)) + '</mark>' + esc(h.text.slice(m.end, m.end + 40));
    return `<div class="m"><label><input type="checkbox" data-gf="${i}" checked><b>${esc(h.name)}</b> <span style="color:var(--mute)">${h.hits.length}×</span></label><small>${snip.replace(/\n/g, ' ')}</small></div>`;
  }).join('') || `<div class="empty">${q ? 'No matches' : 'Type something to find'}</div>`;
  $('#gfc').textContent = q ? `${total} match${total === 1 ? '' : 'es'} in ${gfHits.length} note${gfHits.length === 1 ? '' : 's'}` : '';
  $('#gfa').disabled = !gfHits.length;
}
function openGlobalFind() { $('#gf').style.display = 'flex'; $('#gfq').focus(); $('#gfq').select(); gfRender(); }
function closeGlobalFind() { $('#gf').style.display = 'none'; }
async function gfApply() {
  const q = $('#gfq').value, r = $('#gfr').value;
  const chosen = [...document.querySelectorAll('#gfl [data-gf]')].filter((c) => c.checked).map((c) => gfHits[+c.dataset.gf]);
  if (!chosen.length) return;
  await flush(); let done = 0, failed = 0;
  for (const h of chosen) {
    const n = notes.get(h.name); if (!n) continue;
    const { text } = MD.replaceAll(n.text, q, r);
    try { const res = await api('/api/note?name=' + encodeURIComponent(h.name), { method: 'PUT', body: text, headers: { 'x-base-mtime': String(n.base ?? 0) } }); n.text = text; n.base = res.mtime; done++; }
    catch { failed++; }
  }
  if (cur && notes.get(cur)) { const ed = $('#ed'); if (ed) { ed.value = notes.get(cur).text; syncEditor(); } else renderPane(); }
  renderList(); renderBack(); closeGlobalFind();
  $('#status').textContent = `Replaced in ${done} note${done === 1 ? '' : 's'}` + (failed ? `, ${failed} failed (changed elsewhere)` : '');
}
$('#gfq').oninput = gfRender;
$('#gfx').onclick = closeGlobalFind;
$('#gfa').onclick = gfApply;
$('#gf').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGlobalFind(); else if (e.key === 'Enter' && !$('#gfa').disabled) gfApply(); });
$('#gf').addEventListener('mousedown', (e) => { if (e.target.id === 'gf') closeGlobalFind(); });
/* PDF: print the rendered note (the print stylesheet hides the app chrome); the Mac app prints natively */
async function exportPdf() {
  if (!cur) return;
  await flush(); graphOn = false; preview = true; renderPane();
  if (window.webkit && webkit.messageHandlers && webkit.messageHandlers.mac) macPost({ t: 'print' }); else window.print();
}
function allTasks() {
  const out = [];
  for (const n of notes.values()) for (const t of MD.tasksOf(n.text)) if (!t.done) out.push({ ...t, name: n.name });
  return out;
}
function swRender() {
  if (swMode === 'tasks') {
    const l = $('#swq').value.trim().toLowerCase();
    swRows = allTasks().filter((t) => !l || (t.text + ' ' + t.name).toLowerCase().includes(l)).slice(0, 50);
    swSel = Math.min(swSel, Math.max(0, swRows.length - 1));
    $('#swl').innerHTML = swRows.map((t, i) => `<div class="item${i === swSel ? ' on' : ''}" data-i="${i}"><input type="checkbox" class="tk" data-tk="${i}" title="Mark done">${esc(t.text)}<span class="snip" style="float:right">${esc(t.name)}</span></div>`).join('') || '<div class="empty">No open tasks 🎉</div>';
    return;
  }
  if (swMode === 'cmds') {
    const l = $('#swq').value.trim().toLowerCase();
    const tpls = [...notes.keys()].filter((n) => /^templates\//i.test(n)).sort().map((n) => ({ name: 'New note from template: ' + n.slice(10), run: () => newFromTemplate(n) }));
    swRows = [...COMMANDS, ...tpls].filter((c) => !l || c.name.toLowerCase().includes(l) || l.split(/\s+/).every((w) => c.name.toLowerCase().includes(w)));
    swSel = Math.min(swSel, Math.max(0, swRows.length - 1));
    $('#swl').innerHTML = swRows.map((r, i) => `<div class="item${i === swSel ? ' on' : ''}" data-i="${i}">${esc(r.name)}${r.hint ? `<span class="snip" style="float:right">${esc(r.hint)}</span>` : ''}</div>`).join('') || '<div class="empty">No matching command</div>';
    return;
  }
  const v = $('#swq').value.trim(), l = v.toLowerCase();
  // most recently edited first; names that start with the query beat names that merely contain it
  const rank = (n) => (l && n.toLowerCase().startsWith(l) ? 0 : 1);
  swRows = [...notes.keys()].filter((n) => n.toLowerCase().includes(l))
    .sort((a, b) => rank(a) - rank(b) || (notes.get(b).mtime || 0) - (notes.get(a).mtime || 0)).slice(0, 8);
  if (v && !notes.has(v)) swRows.push({ create: v });
  swSel = Math.min(swSel, swRows.length - 1);
  $('#swl').innerHTML = swRows.map((r, i) => `<div class="item${i === swSel ? ' on' : ''}" data-i="${i}">${r.create ? `Create “${esc(r.create)}”` : esc(r)}</div>`).join('');
}
function swOpen(mode) { swMode = mode || 'notes'; $('#swq').placeholder = swMode === 'cmds' ? 'Type a command…' : swMode === 'tasks' ? 'Filter open tasks…' : 'Jump to or create a note…'; $('#sw').style.display = 'flex'; $('#swq').value = ''; swSel = 0; swRender(); $('#swq').focus(); }
function swClose() { $('#sw').style.display = 'none'; }
async function toggleTask(t) {
  const n = notes.get(t.name); if (!n) return;
  const L = n.text.split('\n'); if (!/\[ \]/.test(L[t.line] || '')) return;
  L[t.line] = L[t.line].replace('[ ]', '[x]'); const text = L.join('\n');
  try {
    const r = await api('/api/note?name=' + encodeURIComponent(t.name), { method: 'PUT', body: text, headers: { 'x-base-mtime': String(n.base ?? 0) } });
    n.text = text; n.base = r.mtime;
    if (cur === t.name) { const ed = $('#ed'); if (ed) { ed.value = text; syncEditor(); } else renderPane(); }
    $('#status').textContent = 'Task done';
  } catch (e) { $('#status').textContent = 'Could not update task: ' + e.message; }
  swRender();
}
function swPick(i) { const r = swRows[i]; swClose(); if (!r) return; if (swMode === 'tasks') { open(r.name, false); return; } if (r.run) setTimeout(r.run, 0); else open(r.create || r, !!r.create); }

/* events */
document.addEventListener('click', (e) => {
  if (document.body.classList.contains('side-open') && !e.target.closest('#side, #menu')) document.body.classList.remove('side-open');
  if (e.target.id === 'emptytrash') { if (confirm('Permanently delete everything in the trash?')) api('/api/trash', { method: 'DELETE' }).then(() => { trashMode = true; showTrash(); }); return; }
  const rs = e.target.closest('[data-restore]');
  if (rs) { api('/api/restore', { method: 'POST', body: JSON.stringify({ id: rs.dataset.restore }) }).then(async (r) => { await load(); trashMode = false; trashIcon(false); renderList(); open(r.name, false); }); return; }
  const tcl = e.target.closest('[data-tabclose]');
  if (tcl) { e.stopPropagation(); closeTab(+tcl.dataset.tabclose); return; }
  const tb = e.target.closest('[data-tab]');
  if (tb) { switchTab(+tb.dataset.tab); return; }
  if (e.target.closest('#newtab')) { newTab(); return; }
  const fo = e.target.closest('[data-folder]');
  if (fo) { const f = fo.dataset.folder; openFolders.has(f) ? openFolders.delete(f) : openFolders.add(f); saveOpenFolders(); renderList(); return; }
  const ssd = e.target.closest('[data-ssdel]');
  if (ssd) { const a = savedSearches(); a.splice(+ssd.dataset.ssdel, 1); setSearches(a); renderTags(); return; }
  const ssc = e.target.closest('[data-ss]');
  if (ssc) { $('#q').value = savedSearches()[+ssc.dataset.ss] || ''; renderList(); return; }
  if (e.target.closest('#sssave')) { const q = $('#q').value.trim(); if (q) setSearches([...savedSearches(), q]); renderTags(); return; }
  if (e.target.closest('#tagmore')) { tagsOpen = !tagsOpen; renderTags(); return; }
  const tg = e.target.closest('[data-tag]');
  if (tg) { e.preventDefault(); activeTag = activeTag === tg.dataset.tag ? null : tg.dataset.tag; renderList(); return; }
  const oh = e.target.closest('[data-h]');
  if (oh) { gotoHeading(+oh.dataset.h); return; }
  const lk = e.target.closest('[data-link]'); if (lk) { linkMention(lk.dataset.link); return; }
  const a = e.target.closest('[data-note]');
  if (a) { e.preventDefault(); const anchor = a.dataset.anchor, block = a.dataset.block;
    if (e.altKey && notes.has(a.dataset.note)) { openSplit(a.dataset.note); return; }
    (e.metaKey || e.ctrlKey ? openInNewTab : open)(a.dataset.note || cur, true).then(() => { if (anchor) gotoAnchor(anchor); else if (block) gotoBlock(block); }); }
});
$('#q').oninput = renderList;
document.addEventListener('auxclick', (e) => {                      // middle-click: close a tab / open a link in a new tab
  if (e.button !== 1) return;
  const tb = e.target.closest?.('[data-tab]'), a = e.target.closest?.('[data-note]');
  if (tb) { e.preventDefault(); closeTab(+tb.dataset.tab); } else if (a) { e.preventDefault(); openInNewTab(a.dataset.note, true); }
});


/* ---------- file tree ---------- */
let view = 'list'; try { view = localStorage.getItem('view') === 'files' ? 'files' : 'list'; } catch {}
let openFolders = new Set(); try { openFolders = new Set(JSON.parse(localStorage.getItem('openFolders') || '[]')); } catch {}
const saveOpenFolders = () => { try { localStorage.setItem('openFolders', JSON.stringify([...openFolders])); } catch {} };
function treeHtml(node, depth) {
  return node.children.map((c) => {
    if (c.type === 'folder') {
      const o = openFolders.has(c.path);
      return `<div class="item fold${o ? ' open' : ''}" data-folder="${esc(c.path)}" style="padding-left:${8 + depth * 14}px"><span class="chev">▸</span>${esc(c.name)} <small>${c.count}</small></div>` + (o ? treeHtml(c, depth + 1) : '');
    }
    return `<div class="item${c.name === cur ? ' on' : ''}" data-note="${esc(c.name)}" draggable="true" style="padding-left:${22 + depth * 14}px">${pins.has(c.name) ? '📌 ' : ''}${esc(c.label)}</div>`;
  }).join('');
}
function setView(v) {
  view = v; try { localStorage.setItem('view', v); } catch {}
  $('#vlist').classList.toggle('on', v === 'list'); $('#vfiles').classList.toggle('on', v === 'files');
  $('#vlist').setAttribute('aria-selected', v === 'list'); $('#vfiles').setAttribute('aria-selected', v === 'files');
  if (!trashMode) renderList();
}
$('#vlist').onclick = () => setView('list'); $('#vfiles').onclick = () => setView('files');
const dropTarget = (e) => { const f = e.target.closest('[data-folder]'), n = e.target.closest('[data-note]');
  return f ? f.dataset.folder : n && n.dataset.note.includes('/') ? n.dataset.note.slice(0, n.dataset.note.lastIndexOf('/')) : ''; };
const dragName = (e) => { const t = e.dataTransfer?.getData('text/plain') || ''; return t.startsWith('plainnote:') ? t.slice(10) : null; };
$('#list').addEventListener('dragstart', (e) => { const n = e.target.closest('[data-note]'); if (!n) return; e.dataTransfer.setData('text/plain', 'plainnote:' + n.dataset.note); e.dataTransfer.effectAllowed = 'move'; });
$('#list').addEventListener('dragover', (e) => {
  if (view !== 'files' || ![...(e.dataTransfer?.types || [])].includes('text/plain')) return;
  e.preventDefault();
  document.querySelectorAll('#list .drop').forEach((x) => x.classList.remove('drop'));
  (e.target.closest('[data-folder]') || (e.target.closest('[data-note]') ? null : $('#list')))?.classList.add('drop');
});
$('#list').addEventListener('dragleave', (e) => { if (!e.relatedTarget || !$('#list').contains(e.relatedTarget)) document.querySelectorAll('#list .drop').forEach((x) => x.classList.remove('drop')); });
$('#list').addEventListener('drop', async (e) => {
  document.querySelectorAll('#list .drop').forEach((x) => x.classList.remove('drop'));
  const name = dragName(e); if (!name || view !== 'files') return;
  e.preventDefault(); const to = dropTarget(e);
  if (to) { openFolders.add(to); saveOpenFolders(); }
  if (await moveNote(name, to)) $('#status').textContent = `Moved to ${to || 'the top level'}`;
});
/* right-click menu */
function showCtx(items, x, y) {
  const el = $('#ctx');
  el.innerHTML = items.map((it, i) => (it ? `<button role="menuitem" data-ctx="${i}">${esc(it[0])}</button>` : '<hr>')).join('');
  el.style.display = 'block';
  el.style.left = Math.min(x, innerWidth - el.offsetWidth - 8) + 'px'; el.style.top = Math.min(y, innerHeight - el.offsetHeight - 8) + 'px';
  el._items = items;
}
const hideCtx = () => { $('#ctx').style.display = 'none'; };
$('#ctx').addEventListener('click', (e) => { const b = e.target.closest('[data-ctx]'); if (!b) return; const it = $('#ctx')._items[+b.dataset.ctx]; hideCtx(); it && it[1](); });
document.addEventListener('mousedown', (e) => { if (!e.target.closest?.('#ctx')) hideCtx(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtx(); });
const uniqueName = (base) => { let i = 0, n; do { n = i ? `${base} ${i + 1}` : base; i++; } while (notes.has(n)); return n; };
async function newFolder(parent) {
  const sub = (prompt('New folder name', '') || '').trim().replace(/[\\:*?"<>|]/g, ''); if (!sub) return;
  const name = parent ? parent + '/' + sub : sub;
  try { await api('/api/folder', { method: 'POST', body: JSON.stringify({ name }) }); } catch (e) { $('#status').textContent = 'Could not create folder: ' + e.message; return; }
  openFolders.add(parent || name); openFolders.add(name); saveOpenFolders(); folders = await api('/api/folders').catch(() => folders); setView('files');
}
async function deleteFolder(path) {
  if (!confirm(`Delete the empty folder “${path}”?`)) return;
  try { await api('/api/folder?name=' + encodeURIComponent(path), { method: 'DELETE' }); }
  catch (e) { $('#status').textContent = e.message === 'not empty' ? 'Folder is not empty' : 'Could not delete: ' + e.message; return; }
  folders = await api('/api/folders').catch(() => folders); renderList();
}
async function duplicateNote(name) {
  const n = notes.get(name); if (!n) return; await flush();
  const copy = uniqueName(name + ' copy');
  const r = await api('/api/note?name=' + encodeURIComponent(copy), { method: 'PUT', body: n.text, headers: { 'x-base-mtime': '0' } });
  notes.set(copy, { name: copy, text: n.text, mtime: Date.now(), base: r.mtime }); await open(copy, false);
}
$('#list').addEventListener('contextmenu', (e) => {
  if (trashMode) return;
  const n = e.target.closest('[data-note]'), f = e.target.closest('[data-folder]');
  e.preventDefault();
  if (n) {
    const name = n.dataset.note, dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
    showCtx([['Open', () => open(name, false)], ['Open in new tab', () => openInNewTab(name, false)], ['Open to the right', () => openSplit(name)], null,
      ['Rename…', async () => { const v = (prompt('Rename note', name.split('/').pop()) || '').trim().replace(/[\\:*?"<>|]/g, ''); if (v && dir + v !== name) await renameNote(name, dir + v); }],
      ['Duplicate', () => duplicateNote(name)],
      ['Move to folder…', async () => { const v = prompt('Move to folder (empty for the top level)', dir.replace(/\/$/, '')); if (v !== null) await moveNote(name, v.trim().replace(/^\/+|\/+$/g, '')); }],
      [pins.has(name) ? 'Unpin' : 'Pin to top', () => { pins.has(name) ? pins.delete(name) : pins.add(name); savePins(); renderPin(); renderList(); }],
      ['Copy link', () => { try { navigator.clipboard.writeText(`[[${name}]]`); } catch {} }], null,
      ['Move to trash…', async () => { await open(name, false); $('#del').click(); }]], e.clientX, e.clientY);
  } else {
    const path = f ? f.dataset.folder : '';
    showCtx([['New note here', async () => { if (path) { openFolders.add(path); saveOpenFolders(); } await open(uniqueName((path ? path + '/' : '') + 'Untitled'), true); }],
      ['New folder…', () => newFolder(path)], ...(f ? [null, ['Delete empty folder…', () => deleteFolder(path)]] : [])], e.clientX, e.clientY);
  }
});

/* ---------- properties (frontmatter) ---------- */
let propsOpen = true, addingProp = false, propsSig = '', curProps = [];
try { propsOpen = localStorage.getItem('propsOpen') !== '0'; } catch {}
function renderProps(force) {
  const el = $('#props');
  if (!cur || graphOn || !notes.get(cur)) { el.style.display = 'none'; propsSig = ''; return; }
  const ps = MD.properties(notes.get(cur).text), sig = JSON.stringify([cur, ps, propsOpen, addingProp]);
  if (!force && sig === propsSig) return;
  if (!force && el.contains(document.activeElement)) return;
  propsSig = sig; curProps = ps; el.style.display = 'block';
  const row = (p, i) => {
    const k = esc(p.key);
    const ctl = p.type === 'checkbox' ? `<input type="checkbox" data-prop="${i}" aria-label="${k}"${p.value ? ' checked' : ''}>`
      : p.type === 'list' ? `<input data-prop="${i}" aria-label="${k}" value="${esc(p.value.join(', '))}" placeholder="a, b, c">`
      : `<input data-prop="${i}" aria-label="${k}" type="${p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text'}" value="${esc(String(p.value))}">`;
    return `<div class="prow"><label title="${k}">${k}</label>${ctl}<button class="x" data-propdel="${i}" aria-label="Remove ${k}" title="Remove">×</button></div>`;
  };
  const head = ps.length ? `<a id="ptoggle">${propsOpen ? '▾' : '▸'} Properties · ${ps.length}</a>` : `<a id="ptoggle">+ Add property</a>`;
  const open = ps.length ? propsOpen : addingProp;
  el.innerHTML = `<div class="phead">${head}</div>` + (open ? ps.map(row).join('') + `<div class="prow add"><input id="pnew" placeholder="New property name" aria-label="New property name"><button id="padd">Add</button></div>` : '');
}
function setNoteText(t) {
  const n = notes.get(cur); if (!n || n.text === t) return;
  n.text = t; n.mtime = Date.now(); aliasMap = null; dirty = true;
  const ed = $('#ed'); if (ed) { ed.value = t; syncEditor(); } else if ($('#pv')) $('#pane').innerHTML = `<div id="pv">${md(t)}</div>`;
  updateWC(); renderOutline(); renderList(); renderProps(true); if (split && split === cur) renderSplitSoon();
  $('#status').textContent = 'Editing…'; clearTimeout(timer); timer = setTimeout(flush, 600);
}
$('#props').addEventListener('change', (e) => {
  const i = e.target.dataset.prop; if (i == null || !curProps[+i]) return;
  const p = curProps[+i]; let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (p.type === 'list') v = String(v).split(',').map((x) => x.trim()).filter(Boolean);
  setNoteText(MD.setProperty(notes.get(cur).text, p.key, v));
});
function addProperty() {
  const k = ($('#pnew')?.value || '').trim().replace(/\s+/g, '-');
  if (!/^[\w-]+$/.test(k)) { $('#status').textContent = 'Property names use letters, numbers, - and _'; return; }
  addingProp = false; setNoteText(MD.setProperty(notes.get(cur).text, k, '')); setTimeout(() => $('#props input[data-prop]:last-of-type')?.focus(), 0);
}
$('#props').addEventListener('click', (e) => {
  if (e.target.closest('#ptoggle')) { if (curProps.length) { propsOpen = !propsOpen; try { localStorage.setItem('propsOpen', propsOpen ? '1' : '0'); } catch {} } else addingProp = !addingProp; renderProps(true); if (addingProp) $('#pnew')?.focus(); return; }
  if (e.target.closest('#padd')) return addProperty();
  const d = e.target.closest('[data-propdel]'); if (d && curProps[+d.dataset.propdel]) setNoteText(MD.removeProperty(notes.get(cur).text, curProps[+d.dataset.propdel].key));
});
$('#props').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'pnew') { e.preventDefault(); addProperty(); } });

/* hover preview: pause on a [[link]] to peek at the note (or the linked section) */
const hp = document.createElement('div'); hp.id = 'hp'; document.body.appendChild(hp);
let hpTimer = 0;
function hpHide() { clearTimeout(hpTimer); hp.style.display = 'none'; }
function hpShow(a) {
  const n = notes.get(a.dataset.note); if (!n) return;
  let body = MD.frontmatter(n.text).body;
  if (a.dataset.anchor) body = MD.section(body, a.dataset.anchor) || body;
  hp.innerHTML = `<div class="hp-title">${esc(n.name.split('/').pop())}</div><div class="hp-body">${md(body.split('\n').slice(0, 14).join('\n')) || '<i>Empty note</i>'}</div>`;
  hp.style.display = 'block';
  const r = a.getBoundingClientRect(), w = hp.offsetWidth, h = hp.offsetHeight;
  hp.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  hp.style.top = (r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
}
document.addEventListener('mouseover', (e) => {
  const a = e.target.closest('#pv a[data-note], #back a[data-note]');
  if (!a || a.classList.contains('new')) return;
  clearTimeout(hpTimer); hpTimer = setTimeout(() => hpShow(a), 450);
});
document.addEventListener('mouseout', (e) => { if (e.target.closest('#pv a[data-note], #back a[data-note], #hp')) hpHide(); });
document.addEventListener('mousedown', hpHide); document.addEventListener('scroll', hpHide, true);

/* sync */
async function syncStatus() {
  try { const s = await api('/api/sync/status');
    $('#ss').textContent = !s.isRepo || !s.remote ? 'Not set up' : s.dirty ? `${s.dirty} unsynced` : 'Up to date';
    return s; } catch { return null; }
}
let syncing = false;
async function doSync(auto) {
  if (syncing) return; syncing = true;
  const btn = $('#sync'); btn.disabled = true;
  try {
    await flush();
    let s = await syncStatus();
    if (!s?.isRepo || !s.remote) {
      if (auto) return;
      const url = prompt('Git remote URL for syncing (https://…, ssh://… or git@host:user/repo.git).\nCreate an empty private repo first.', s?.remote || '');
      if (!url) return;
      await api('/api/sync/setup', { method: 'POST', body: JSON.stringify({ url: url.trim() }) });
    }
    $('#ss').textContent = 'Syncing…';
    const before = cur && notes.get(cur)?.text;
    const r = await api('/api/sync', { method: 'POST' });
    if (dirty) { $('#ss').textContent = r.message; return; }   // user typed meanwhile; don't clobber
    await load();
    if (cur && !notes.has(cur)) { cur = null; renderPane(); renderBack(); }
    else if (cur && notes.get(cur).text !== before) renderPane();
    $('#ss').textContent = r.message; $('#ss').title = '';
    macPost({ t: 'notify', title: 'Sync finished', body: r.message });
  } catch (e) { $('#ss').textContent = e.message; $('#ss').title = e.message; macPost({ t: 'notify', title: 'Sync failed', body: e.message }); }
  finally { btn.disabled = false; syncing = false; }
}
$('#sync').onclick = () => doSync(false);
let autoTimer = null;
function setAuto(on) {
  clearInterval(autoTimer); autoTimer = on ? setInterval(() => { if (!document.hidden) doSync(true); }, 120000) : null;
  try { localStorage.setItem('autoSync', on ? '1' : ''); } catch {}
}
$('#auto').onchange = (e) => { setAuto(e.target.checked); if (e.target.checked) doSync(true); };
try { if (localStorage.getItem('autoSync')) { $('#auto').checked = true; setAuto(true); } } catch {}
syncStatus();
/* text size: Ctrl/Cmd + / - / 0 (editor and preview), remembered */
let fontSize = 14; try { fontSize = Number(localStorage.getItem('fontSize')) || 14; } catch {}
function setFontSize(n, save) {
  fontSize = Math.min(28, Math.max(10, n));
  document.documentElement.style.setProperty('--fs', fontSize + 'px');
  if (save) try { fontSize === 14 ? localStorage.removeItem('fontSize') : localStorage.setItem('fontSize', fontSize); } catch {}
  syncEditor(); caretIntoView();
}
document.documentElement.style.setProperty('--fs', fontSize + 'px');
/* toolbar icons (inline SVG; the buttons keep their ids and aria-labels) */
const ICO = {
  plus: '<path d="M8 3v10M3 8h10"/>', cal: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  sync: '<path d="M13 8a5 5 0 0 0-9-3M3 2.5V5h2.5M3 8a5 5 0 0 0 9 3M13 13.5V11h-2.5"/>', trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4"/>',
  box: '<rect x="2.5" y="3" width="11" height="3" rx="1"/><path d="M3.5 6v6.5h9V6M6.5 9h3"/>', pin: '<path d="M6 2.5h4l-.7 4 2 2.2H4.7l2-2.2zM8 8.7v4.8"/>',
  graph: '<circle cx="4" cy="4.5" r="1.6"/><circle cx="12" cy="5" r="1.6"/><circle cx="8" cy="12" r="1.6"/><path d="M5.3 5.5l5.4-.3M5 6l2.2 4.6M10.8 6.4L8.9 10.5"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>', pencil: '<path d="M3 13l.6-3L11 2.6a1.4 1.4 0 0 1 2 2L5.6 12zM9.8 3.8l2.4 2.4"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>', more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>', del: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
};
function setIcon(sel, name, label) {
  const b = $(sel); if (!b) return;
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICO[name]}</svg>`; b.classList.add('ico');
  if (label) b.setAttribute('aria-label', label);
}
[['#new', 'plus'], ['#today', 'cal'], ['#sync', 'sync'], ['#trash', 'box'], ['#gr', 'graph'], ['#del', 'del'], ['#more', 'more']].forEach(([s, n]) => setIcon(s, n));
setIcon('#pin', 'pin'); setIcon('#tog', 'eye');
function trashIcon(on) { setIcon('#trash', on ? 'cal' : 'box', on ? 'Back to notes' : 'Trash'); $('#trash').title = on ? 'Back to notes' : 'Deleted notes'; }
$('#more').onclick = (e) => { e.stopPropagation(); $('#moremenu').classList.toggle('on'); };
document.addEventListener('click', () => $('#moremenu').classList.remove('on'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#moremenu').classList.remove('on'); });
$('#pdfb').onclick = () => exportPdf(); $('#gfb').onclick = () => openGlobalFind();
/* theme: auto (follow the system) -> light -> dark */
const THEMES = ['auto', 'light', 'dark'], ICON = { auto: '◐', light: '☀', dark: '☾' };
function applyTheme(t, save) {
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme; else root.dataset.theme = t;
  $('#theme').textContent = ICON[t]; $('#theme').title = `Theme: ${t} (click or Ctrl/Cmd+Shift+L to change)`; $('#theme').dataset.mode = t;
  macPost({ t: 'theme', v: t });
  if (save) try { t === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', t); } catch {}
}
let savedTheme = 'auto'; try { savedTheme = localStorage.getItem('theme') || 'auto'; } catch {}
applyTheme(THEMES.includes(savedTheme) ? savedTheme : 'auto', false);
$('#theme').onclick = () => applyTheme(THEMES[(THEMES.indexOf($('#theme').dataset.mode) + 1) % 3], true);
$('#new').onclick = newNote;
$('#today').onclick = openToday;
$('#exp').onclick = exportHtml;
$('#pin').onclick = () => { if (!cur) return; pins.has(cur) ? pins.delete(cur) : pins.add(cur); savePins(); renderPin(); renderList(); };
$('#gr').onclick = async () => { await flush(); graphOn = !graphOn; renderPane(); };
$('#tog').onclick = () => { if (!cur) return; graphOn = false; preview = !preview; flush(); renderPane(); };
$('#del').onclick = async () => {
  if (!cur || !confirm(`Move “${cur}” to the trash?`)) return;
  await api('/api/note?name=' + encodeURIComponent(cur), { method: 'DELETE' });
  const gone = cur, keep = tabs[ti]; tabs = tabs.filter((t) => t === keep || t.name !== gone); keep.name = null; ti = tabs.indexOf(keep); renderTabs(); saveTabs();
  notes.delete(cur); cur = null; dirty = false; if (split === gone) closeSplit(); $('#status').textContent = ''; $('#title').value = ''; $('#title').disabled = true;
  location.hash = ''; renderList(); renderPane(); renderBack();
};
let trashMode = false;
async function showTrash() {
  trashMode = !trashMode; trashIcon(trashMode);
  if (!trashMode) return renderList();
  const items = await api('/api/trash');
  $('#tags').innerHTML = '';
  $('#list').innerHTML = (items.length ? `<div class="trashrow" style="padding:4px 8px"><span>${items.length} deleted</span><button id="emptytrash">Empty</button></div>` : '')
    + (items.map((t) => `<div class="item trashrow" data-restore="${esc(t.id)}" title="Click to restore"><span>${esc(t.name)}</span><small>↩</small></div>`).join('') || '<div class="empty">Trash is empty</div>');
}
$('#trash').onclick = showTrash;
$('#menu').onclick = () => document.body.classList.toggle('side-open');
$('#title').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
$('#title').onchange = rename;
$('#swq').oninput = () => { swSel = 0; swRender(); };
$('#swl').onclick = (e) => { const tk = e.target.closest('[data-tk]'); if (tk) { e.stopPropagation(); toggleTask(swRows[+tk.dataset.tk]); return; } const i = e.target.closest('[data-i]'); if (i) swPick(+i.dataset.i); };
$('#sw').onmousedown = (e) => { if (e.target.id === 'sw') swClose(); };
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if ($('#sw').style.display === 'flex') {
    if (e.key === 'Escape') swClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); swSel = Math.min(swSel + 1, swRows.length - 1); swRender(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); swSel = Math.max(swSel - 1, 0); swRender(); }
    else if (e.key === 'Enter') swPick(swSel);
    return;
  }
  if (e.key === 'Escape' && document.body.classList.contains('focus') && !frOpen()) { toggleFocus(); return; }
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (e.shiftKey && (e.key === '[' || e.key === '{')) { e.preventDefault(); stepTab(-1); }
  else if (e.shiftKey && (e.key === ']' || e.key === '}')) { e.preventDefault(); stepTab(1); }
  else if (e.altKey && e.code === 'Backslash') { e.preventDefault(); if (cur) openSplit(cur); }
  else if (k === 't' && !e.shiftKey) { e.preventDefault(); newTab(); }
  else if (k === 'w' && !e.shiftKey) { e.preventDefault(); closeTabCmd(); }
  else if (k === 'p' && e.shiftKey) { e.preventDefault(); swOpen('cmds'); }
  else if (k === 'k') { e.preventDefault(); swOpen(); }
  else if (k === 'n') { e.preventDefault(); newNote(); }
  else if (k === 'g') { e.preventDefault(); $('#gr').click(); }
  else if (k === 'e') { e.preventDefault(); $('#tog').click(); }
  else if (k === 's') { e.preventDefault(); flush(); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); toggleFocus(); }
  else if (k === 'h' && e.shiftKey) { e.preventDefault(); openGlobalFind(); }
  else if (k === 'f') { e.preventDefault(); openFind(); }
  else if (k === 't' && e.shiftKey) { e.preventDefault(); openToday(); }
  else if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontSize(fontSize + 1, true); }
  else if (e.key === '-') { e.preventDefault(); setFontSize(fontSize - 1, true); }
  else if (e.key === '0') { e.preventDefault(); setFontSize(14, true); }
  else if (e.key === '[') { e.preventDefault(); history.back(); }
  else if (e.key === ']') { e.preventDefault(); history.forward(); }
  else if (k === 'l' && e.shiftKey) { e.preventDefault(); $('#theme').click(); }
});
window.addEventListener('focus', async () => {
  if (dirty) return;
  const c = cur, before = c && notes.get(c)?.text;
  await load();
  if (c && cur === c && !notes.has(c)) { cur = null; renderPane(); renderBack(); }
  else if (c && cur === c && !dirty && !graphOn && notes.get(c).text !== before) renderPane();   // changed on disk meanwhile
});

setInterval(() => fetch('/api/ping').catch(() => {}), 10000);   // lets the desktop launcher notice when the window is closed
/* back / forward: every opened note is a history entry, so the browser buttons, Alt+Arrows and Ctrl/Cmd+[ ] walk through them */
window.addEventListener('hashchange', () => {
  let h = ''; try { h = decodeURIComponent(location.hash.slice(1)); } catch {}
  if (h && h !== cur && notes.has(h)) open(h, false);
});
setView(view);
plainnote.ready = load().then(async () => {
  let h = decodeURIComponent(location.hash.slice(1));
  try {                                                              // restore the tabs from last time
    const sv = JSON.parse(localStorage.getItem('tabs') || 'null'); let seen = 0, idx = 0; const ok = [];
    if (sv && Array.isArray(sv.tabs)) sv.tabs.forEach((t, j) => { if (t && t.name && notes.has(t.name)) { if (j === sv.i) idx = seen; seen++; ok.push({ name: t.name, preview: !!t.preview }); } });
    if (ok.length) { tabs = ok; ti = Math.min(idx, ok.length - 1); if (!h) { h = ok[ti].name; pendingPreview = ok[ti].preview; } }
  } catch {}
  if (!h) try { h = localStorage.getItem('last') || ''; } catch {}   // reopen where you left off
  renderSplit();
  if (h) await open(h, false);
  if (/[?&]graph\b/.test(location.search)) { graphOn = true; renderPane(); }   // ?graph opens the graph view (used for screenshots)
  if (/[?&]preview\b/.test(location.search) && cur) { preview = true; renderPane(); }
});
