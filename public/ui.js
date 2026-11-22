// Shared UI building blocks: toasts, one dialog implementation (focus trap, Esc, backdrop, focus return, inert background),
// text/confirm prompts that replace the browser's prompt()/confirm(), empty states, and fuzzy matching for the palette.
(function (root) {
  'use strict';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- fuzzy matching ----------
  // Returns { score, idx } (idx = matched character positions, for highlighting) or null. An exact substring always beats a scattered match;
  // among scattered matches, runs of consecutive characters and matches at word starts score higher.
  function fuzzy(query, text) {
    const q = String(query).toLowerCase().replace(/\s+/g, ' ').trim(), t = String(text).toLowerCase();
    if (!q) return { score: 0, idx: [] };
    const at = t.indexOf(q);
    if (at >= 0) {
      const wordStart = at === 0 || /[^a-z0-9]/.test(t[at - 1]);
      const idx = Array.from({ length: q.length }, (_, i) => at + i);
      return { score: 1000 - at * 2 + (at === 0 ? 200 : 0) + (wordStart ? 100 : 0) - (t.length - q.length), idx };
    }
    // Scattered match: try the leftmost path and a path that prefers word starts, and keep the better one (a greedy walk alone would match
    // the "g" inside "Toggle" for "tg" instead of the "g" that starts "graph").
    const isStart = (i) => i === 0 || /[^a-z0-9]/.test(t[i - 1]);
    const walk = (preferStart) => {
      const idx = []; let pos = 0, score = 0, prev = -2;
      for (const ch of q) {
        if (ch === ' ') continue;
        let i = -1;
        if (preferStart) for (let k = t.indexOf(ch, pos); k >= 0; k = t.indexOf(ch, k + 1)) if (isStart(k)) { i = k; break; }
        if (i < 0) i = t.indexOf(ch, pos);
        if (i < 0) return null;
        if (idx.length && i !== prev + 1 && !isStart(i)) return null;                // a scattered match reads as an abbreviation: after the first letter, each one continues a run or starts a word
        score += 10 + (i === prev + 1 ? 15 : 0) + (isStart(i) ? 20 : 0) - Math.min(i - pos, 8);
        idx.push(i); prev = i; pos = i + 1;
      }
      return { score: score - Math.floor(t.length / 8), idx };
    };
    const a = walk(false), b = walk(true);
    if (!a && !b) return null;
    return !a ? b : !b ? a : b.score > a.score ? b : a;
  }
  // The text with matched characters wrapped in <mark>, safely escaped.
  function highlight(text, idx) {
    if (!idx || !idx.length) return esc(text);
    const set = new Set(idx); let out = '', open = false;
    [...String(text)].forEach((c, i) => { const m = set.has(i); if (m && !open) { out += '<mark>'; open = true; } else if (!m && open) { out += '</mark>'; open = false; } out += esc(c); });
    return open ? out + '</mark>' : out;
  }

  const hasDom = typeof document !== 'undefined';

  // ---------- toasts ----------
  // toast('Saved') | toast('Deleted “x”', { action: { label: 'Undo', run } }) | toast('Failed', { kind: 'error' }). Errors stay until dismissed.
  let toastBox = null;
  function toast(msg, opts = {}) {
    if (!hasDom) return { close() {} };
    if (!toastBox || !toastBox.isConnected) {
      toastBox = document.createElement('div'); toastBox.id = 'toasts'; toastBox.setAttribute('role', 'status'); toastBox.setAttribute('aria-live', 'polite'); toastBox.setAttribute('aria-relevant', 'additions');
      document.body.appendChild(toastBox);
    }
    const kind = opts.kind || 'info', el = document.createElement('div');
    el.className = 'toast ' + kind;
    const span = document.createElement('span'); span.textContent = msg; el.appendChild(span);
    let timer = 0; const close = () => { clearTimeout(timer); el.remove(); };
    if (opts.action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = opts.action.label; b.onclick = () => { close(); opts.action.run(); }; el.appendChild(b); }
    if (kind === 'error' || opts.sticky) { const x = document.createElement('button'); x.type = 'button'; x.className = 'toast-x'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×'; x.onclick = close; el.appendChild(x); }
    while (toastBox.children.length >= 4) toastBox.firstChild.remove();
    toastBox.appendChild(el);
    const ms = opts.ms ?? (kind === 'error' || opts.sticky ? 0 : opts.action ? 8000 : 3500);
    if (ms) timer = setTimeout(close, ms);
    return { close, el };
  }

  // ---------- modal stack: inert background, Tab focus trap, Esc, focus return (shared by dialogs and the page's own overlays) ----------
  const stack = [];
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const setInert = (on) => { for (const sel of ['#app', '#tabbar']) { const e = document.querySelector(sel); if (e) { if (on) e.setAttribute('inert', ''); else e.removeAttribute('inert'); } } };
  function onModalKey(e) {
    const top = stack[stack.length - 1]; if (!top) return;                          // only the topmost modal reacts
    if (e.key === 'Escape' && top.onEscape) { e.preventDefault(); e.stopPropagation(); top.onEscape(); }
    else if (e.key === 'Tab') {
      const box = top.el, f = [...box.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === first || !box.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !box.contains(a))) { e.preventDefault(); first.focus(); }
    }
  }
  // modal(el, { onEscape }) -> { release() }: makes `el` the only reachable part of the page until released, then returns focus to where it was.
  function modal(el, opts = {}) {
    const opener = document.activeElement, h = { el, onEscape: opts.onEscape };
    if (!stack.length) { document.addEventListener('keydown', onModalKey, true); setInert(true); }
    stack.push(h);
    return { release() {
      const i = stack.indexOf(h); if (i < 0) return; stack.splice(i, 1);
      if (!stack.length) { document.removeEventListener('keydown', onModalKey, true); setInert(false); }
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    } };
  }

  // ---------- dialogs ----------
  // openDialog({ title, body (HTML string or Element), actions: [{ label, primary, danger, id, onClick(close) }], onClose, canClose, focus, width, className, id })
  //   -> { box, body, close(result), closed: Promise<result> }
  function openDialog(o) {
    const id = 'dlg' + Math.random().toString(36).slice(2, 8);
    const scrim = document.createElement('div'); scrim.className = 'dlg-scrim';
    scrim.innerHTML = `<div class="dlg ${o.className || ''}" role="dialog" aria-modal="true" aria-labelledby="${id}t"${o.width ? ` style="--w:${o.width}"` : ''}><header><h3 id="${id}t"></h3><button type="button" class="dlg-x" aria-label="Close">×</button></header><div class="dlg-body"></div><footer class="dlg-act"></footer></div>`;
    const box = scrim.firstChild, body = box.querySelector('.dlg-body'), foot = box.querySelector('footer');
    if (o.id) box.id = o.id;
    box.querySelector('h3').textContent = o.title || '';
    if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
    let resolve; const closed = new Promise((r) => { resolve = r; }); let isClosed = false, m;
    const close = (result) => {
      if (isClosed) return; if (o.canClose && !o.canClose()) return; isClosed = true;
      scrim.remove(); m.release();
      if (o.onClose) o.onClose(result); resolve(result);
    };
    for (const a of o.actions || []) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = a.label; if (a.primary) b.className = 'pri'; if (a.danger) b.classList.add('danger'); if (a.id) b.id = a.id; if (a.disabled) b.disabled = true;
      b.onclick = () => (a.onClick ? a.onClick(close, b) : close(a.label)); foot.appendChild(b);
    }
    if (!foot.children.length) foot.remove();
    box.querySelector('.dlg-x').onclick = () => close(null);
    let downOnScrim = false;
    scrim.addEventListener('mousedown', (e) => { downOnScrim = e.target === scrim; });
    scrim.addEventListener('click', (e) => { if (e.target === scrim && downOnScrim) close(null); });      // a drag that merely ends on the backdrop does not close it
    document.body.appendChild(scrim); m = modal(box, { onEscape: () => close(null) });
    const target = (o.focus && box.querySelector(o.focus)) || box.querySelector('input:not([type=hidden]),textarea,select') || foot?.querySelector('.pri:not([disabled])') || box.querySelector('button:not([disabled])');
    if (target) target.focus();
    return { box, body, close, closed };
  }

  // Promise-based replacements for prompt() and confirm(): styled, keyboard-friendly, validated inline.
  function askText({ title, message, value = '', placeholder = '', ok = 'OK', validate, label }) {
    return new Promise((resolve) => {
      const form = document.createElement('form'); form.className = 'dlg-form';
      form.innerHTML = `${message ? `<p class="dlg-msg"></p>` : ''}<label class="dlg-lbl"><span></span><input type="text" autocomplete="off" spellcheck="false"></label><div class="dlg-err" role="alert"></div>`;
      if (message) form.querySelector('.dlg-msg').textContent = message;
      const input = form.querySelector('input'), lbl = form.querySelector('.dlg-lbl span'); input.value = value; input.placeholder = placeholder; lbl.textContent = label || ''; if (!label) lbl.remove();
      const err = form.querySelector('.dlg-err');
      const d = openDialog({ title, body: form, focus: 'input', actions: [{ label: 'Cancel', onClick: (c) => c(null) }, { label: ok, primary: true, onClick: () => form.requestSubmit() }] });
      input.select();
      form.onsubmit = (e) => { e.preventDefault(); const v = input.value; const bad = validate ? validate(v) : ''; if (bad) { err.textContent = bad; input.focus(); return; } d.close(v); };
      d.closed.then((r) => resolve(r === null || r === undefined ? null : r));
    });
  }
  function askConfirm({ title, message, ok = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const p = document.createElement('p'); p.className = 'dlg-msg'; p.textContent = message || '';
      const d = openDialog({ title, body: p, actions: [{ label: 'Cancel', onClick: (c) => c(false) }, { label: ok, primary: true, danger, id: 'dlg-ok', onClick: (c) => c(true) }], focus: '#dlg-ok' });
      d.closed.then((r) => resolve(r === true));
    });
  }

  // Renders a friendly empty state into `el`: { title, body, actions: [{ label, run, primary }] }
  function emptyState(el, o) {
    el.innerHTML = `<div class="empty-state"><h3></h3><p></p><div class="es-actions"></div></div>`;
    el.querySelector('h3').textContent = o.title || ''; el.querySelector('p').textContent = o.body || '';
    const box = el.querySelector('.es-actions');
    for (const a of o.actions || []) { const b = document.createElement('button'); b.type = 'button'; b.textContent = a.label; if (a.primary) b.className = 'pri'; b.onclick = a.run; box.appendChild(b); }
    if (!box.children.length) box.remove();
  }

  const api = { fuzzy, highlight, esc, toast, modal, openDialog, askText, askConfirm, emptyState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PNUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
