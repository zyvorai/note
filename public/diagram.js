// Diagrams for ```diagram fences: flow diagrams and sequence diagrams as dependency-free SVG (currentColor, so they follow light/dark and print).
//
//   Flow (default):     Browser -> Server: HTTP          one chain per line, `: label` on the last arrow
//                       Server --> Cache                 `-->` dashed arrow, `---` plain line
//                       (Start) -> {Valid?} -> [(DB)]    shapes: (pill) {diamond} [(database)] ((circle)); default is a rounded box
//                       Server #green                    colour a node: #blue #green #orange #pink #teal #gold #red #gray or #rrggbb
//   Header lines:       down | right      layout direction (right is the default)
//                       title: My system
//   Sequence:           first line `sequence`, then `Alice -> Bob: Hello` and `Bob --> Alice: Hi` (dashed = reply)
(function (root) {
  'use strict';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const COLORS = { blue: '#5b5bd6', green: '#2f8f5b', orange: '#c2570c', pink: '#d6409f', teal: '#0e8fb0', gold: '#8a6d00', red: '#c0392b', gray: '#6e6e73', grey: '#6e6e73' };
  const colorOf = (c) => (!c ? null : COLORS[c.toLowerCase()] || (/^[0-9a-f]{6}$|^[0-9a-f]{3}$/i.test(c) ? '#' + c : null));
  const ARROW = /\s*(-->|->|---)\s*/;

  function parseNode(tok) {
    let color = null, m;
    tok = tok.replace(/\s+#([A-Za-z]+|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, (_, c) => { color = colorOf(c); return ''; }).trim();
    let shape = 'box';
    if ((m = /^\(\((.*)\)\)$/.exec(tok))) { shape = 'circle'; tok = m[1]; }
    else if ((m = /^\[\((.*)\)\]$/.exec(tok))) { shape = 'db'; tok = m[1]; }
    else if ((m = /^\((.*)\)$/.exec(tok))) { shape = 'pill'; tok = m[1]; }
    else if ((m = /^\{(.*)\}$/.exec(tok))) { shape = 'diamond'; tok = m[1]; }
    return { label: tok.trim(), shape, color };
  }
  const textW = (s) => s.length * 7.6;
  const sizeOf = (n) => {
    const w = Math.max(72, textW(n.label) + 28);
    if (n.shape === 'diamond') return { w: Math.max(96, textW(n.label) + 56), h: 58 };
    if (n.shape === 'circle') { const d = Math.max(56, textW(n.label) + 22); return { w: d, h: d }; }
    if (n.shape === 'db') return { w, h: 50 };
    return { w, h: 38 };
  };
  const tx = (x, y, s, a = '') => `<text x="${x}" y="${y}" fill="currentColor"${a}>${esc(s)}</text>`;
  const ariaLabel = (kind, title, names) => `${kind}${title ? ': ' + esc(title) : ': ' + esc(names.join(', '))}`;
  const DEFS = '<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>';
  const svgWrap = (w, h, label, inner) => `<svg class="diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" width="${Math.ceil(w)}" role="img" aria-label="Diagram ${label}" style="max-width:100%;height:auto" font-family="-apple-system,system-ui,Helvetica,Arial,sans-serif">${DEFS}${inner}</svg>`;

  function shapeSvg(n, p) {
    const c = n.color || 'currentColor', fill = n.color ? `fill="${c}" fill-opacity=".14"` : 'fill="none"', st = `stroke="${c}" stroke-width="1.5"`;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    let s;
    if (n.shape === 'diamond') s = `<polygon points="${cx},${p.y} ${p.x + p.w},${cy} ${cx},${p.y + p.h} ${p.x},${cy}" ${fill} ${st} stroke-linejoin="round"/>`;
    else if (n.shape === 'circle') s = `<ellipse cx="${cx}" cy="${cy}" rx="${p.w / 2}" ry="${p.h / 2}" ${fill} ${st}/>`;
    else if (n.shape === 'db') { const ry = 7; s = `<path d="M${p.x} ${p.y + ry}V${p.y + p.h - ry}A${p.w / 2} ${ry} 0 0 0 ${p.x + p.w} ${p.y + p.h - ry}V${p.y + ry}A${p.w / 2} ${ry} 0 0 0 ${p.x} ${p.y + ry}Z" ${fill} ${st}/><path d="M${p.x} ${p.y + ry}A${p.w / 2} ${ry} 0 0 0 ${p.x + p.w} ${p.y + ry}" fill="none" ${st}/>`; }
    else s = `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${n.shape === 'pill' ? p.h / 2 : 8}" ${fill} ${st}/>`;
    return s + tx(cx, cy + (n.shape === 'db' ? 9 : 4.5), n.label, ' text-anchor="middle" font-size="13"');
  }

  // Header lines (`title:`, direction) may appear in any order before the content.
  function header(lines, kinds) {
    const h = { title: '', dir: null };
    while (lines.length) {
      const t = /^title:\s*(.*)$/i.exec(lines[0]);
      if (t) { h.title = t[1].trim(); lines.shift(); }
      else if (kinds.dir && /^(down|vertical|tb|td|right|horizontal|lr)$/i.test(lines[0])) { h.dir = /^(down|vertical|tb|td)$/i.test(lines.shift()) ? 'down' : 'right'; }
      else break;
    }
    return h;
  }
  const clean = (src) => String(src).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  function flow(lines) {
    const h = header(lines, { dir: true }), down = h.dir === 'down';
    const nodes = [], edges = [], byLabel = new Map();
    const node = (tok) => {
      const n = parseNode(tok); if (!n.label) return -1;
      const k = n.label.toLowerCase();
      if (!byLabel.has(k)) { byLabel.set(k, nodes.length); nodes.push(n); }
      else { const e = nodes[byLabel.get(k)]; if (e.shape === 'box' && n.shape !== 'box') e.shape = n.shape; if (!e.color && n.color) e.color = n.color; }
      return byLabel.get(k);
    };
    for (const line of lines) {
      let chain = line, label = '';
      const arrows = [...line.matchAll(/-->|->|---/g)];
      if (arrows.length) {                                   // the edge label is the text after the first colon that follows the last arrow
        const last = arrows[arrows.length - 1], from = last.index + last[0].length;
        let depth = 0, ci = -1;                              // a colon inside (…) […] {…} belongs to the node's own text
        for (let i = from; i < line.length && ci < 0; i++) { const c = line[i]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth = Math.max(0, depth - 1); else if (c === ':' && !depth) ci = i; }
        if (ci >= 0) { chain = line.slice(0, ci); label = line.slice(ci + 1).trim(); }
      }
      const parts = chain.split(ARROW);                      // [node, op, node, op, node ...]
      const ids = [], ops = [];
      for (let i = 0; i < parts.length; i++) { if (i % 2) ops.push(parts[i]); else if (parts[i].trim()) ids.push(node(parts[i])); }
      if (ids.length === 1 && !ops.length) continue;
      for (let i = 0; i + 1 < ids.length; i++) if (ids[i] >= 0 && ids[i + 1] >= 0) edges.push({ a: ids[i], b: ids[i + 1], op: ops[i] || '->', label: i + 2 === ids.length ? label : '' });
    }
    if (!nodes.length) return '';
    const layer = nodes.map(() => 0);
    for (let pass = 0; pass < nodes.length; pass++) for (const e of edges) if (e.a !== e.b && layer[e.b] < layer[e.a] + 1 && layer[e.a] < nodes.length) layer[e.b] = layer[e.a] + 1;
    const cols = []; nodes.forEach((_, i) => (cols[layer[i]] = cols[layer[i]] || []).push(i));
    const sz = nodes.map(sizeOf), M = down ? 'h' : 'w', X = down ? 'w' : 'h', lab = Math.max(0, ...edges.map((e) => e.label.length));
    const GM = down ? Math.max(48, lab ? 56 : 0) : Math.max(64, lab * 6.8 + 28), GX = 26, PAD = 14, top = h.title ? 34 : 0;
    const colM = cols.map((c) => (c ? Math.max(...c.map((i) => sz[i][M])) : 0)), colX = cols.map((c) => (c ? c.reduce((t, i) => t + sz[i][X], 0) + (c.length - 1) * GX : 0));
    const span = Math.max(...colX, 0), pos = []; let off = PAD;
    cols.forEach((c, k) => {
      if (!c) return; let t = PAD + (span - colX[k]) / 2;
      for (const i of c) {
        const m = off + (colM[k] - sz[i][M]) / 2;
        pos[i] = down ? { x: t, y: m + top, w: sz[i].w, h: sz[i].h } : { x: m, y: t + top, w: sz[i].w, h: sz[i].h };
        t += sz[i][X] + GX;
      }
      off += colM[k] + GM;
    });
    let wTot = Math.max(...pos.map((p) => p.x + p.w)) + PAD; const hTot = Math.max(...pos.map((p) => p.y + p.h)) + PAD;
    let g = h.title ? tx(wTot / 2, 22, h.title, ' text-anchor="middle" font-size="15" font-weight="600"') : '';
    for (const e of edges) {
      if (e.a === e.b) continue;
      const A = pos[e.a], B = pos[e.b], back = down ? B.y < A.y : B.x < A.x;
      const x1 = down ? A.x + A.w / 2 : back ? A.x : A.x + A.w, y1 = down ? (back ? A.y : A.y + A.h) : A.y + A.h / 2;
      const x2 = down ? B.x + B.w / 2 : back ? B.x + B.w : B.x, y2 = down ? (back ? B.y + B.h : B.y) : B.y + B.h / 2;
      g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="1.5"${e.op === '-->' ? ' stroke-dasharray="6 4"' : ''}${e.op === '---' ? '' : ' marker-end="url(#ar)"'}/>`;
      if (e.label) g += tx((x1 + x2) / 2, (y1 + y2) / 2 - 6, e.label, ' text-anchor="middle" font-size="11" opacity=".8"');
    }
    nodes.forEach((n, i) => { g += shapeSvg(n, pos[i]); });
    wTot = Math.max(wTot, h.title ? textW(h.title) + 40 : 0);
    return svgWrap(wTot, hTot, ariaLabel('(flow)', h.title, nodes.map((n) => n.label)), g);
  }

  function sequence(lines) {
    const h = header(lines, {}), parts = [], msgs = [];
    const part = (n) => { n = n.trim(); let i = parts.indexOf(n); if (i < 0) { parts.push(n); i = parts.length - 1; } return i; };
    for (const l of lines) {
      const m = /^(.+?)\s*(-->|->)\s*(.+?)\s*(?::\s*(.*))?$/.exec(l);
      if (m) msgs.push({ a: part(m[1]), b: part(m[3]), dashed: m[2] === '-->', text: (m[4] || '').trim() }); else if (!/:/.test(l)) part(l);
    }
    if (!parts.length) return '';
    const longest = Math.max(0, ...msgs.filter((x) => x.a !== x.b).map((x) => x.text.length));
    const gap = Math.max(150, longest * 6.8 + 36), PAD = 16, top = h.title ? 34 : 0, HH = 36, ROW = 42;
    const bw = parts.map((n) => Math.max(88, textW(n) + 26)), cx = parts.map((_, i) => PAD + Math.max(...bw) / 2 + i * gap);
    const y0 = PAD + top + HH, yEnd = y0 + 24 + Math.max(1, msgs.length) * ROW, wTot = cx[cx.length - 1] + Math.max(...bw) / 2 + PAD;
    let g = h.title ? tx(wTot / 2, 22, h.title, ' text-anchor="middle" font-size="15" font-weight="600"') : '';
    parts.forEach((n, i) => { g += `<line x1="${cx[i]}" y1="${y0}" x2="${cx[i]}" y2="${yEnd}" stroke="currentColor" stroke-width="1" stroke-dasharray="4 4" opacity=".45"/>`; });
    msgs.forEach((m, k) => {
      const y = y0 + 24 + k * ROW + 14, dash = m.dashed ? ' stroke-dasharray="6 4"' : '';
      if (m.a === m.b) {
        g += `<path d="M${cx[m.a]} ${y - 8}h26v16h-24" fill="none" stroke="currentColor" stroke-width="1.5"${dash} marker-end="url(#ar)"/>` + (m.text ? tx(cx[m.a] + 32, y + 4, m.text, ' font-size="11" opacity=".85"') : '');
      } else {
        const x1 = cx[m.a], x2 = cx[m.b];
        g += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="currentColor" stroke-width="1.5"${dash} marker-end="url(#ar)"/>` + (m.text ? tx((x1 + x2) / 2, y - 6, m.text, ' text-anchor="middle" font-size="11" opacity=".85"') : '');
      }
    });
    parts.forEach((n, i) => { const w = bw[i], x = cx[i] - w / 2, y = PAD + top; g += `<rect x="${x}" y="${y}" width="${w}" height="${HH}" rx="8" fill="var(--bg,#fff)" stroke="currentColor" stroke-width="1.5"/>` + tx(cx[i], y + HH / 2 + 4.5, n, ' text-anchor="middle" font-size="13"'); });
    return svgWrap(Math.max(wTot, h.title ? textW(h.title) + 40 : 0), yEnd + PAD, ariaLabel('(sequence)', h.title, parts), g);
  }

  function render(src) {
    const lines = clean(src);
    if (!lines.length) return '';
    const titles = []; let seq = false;                      // `title:` and `sequence` may come in either order at the top
    while (lines.length && (/^title:/i.test(lines[0]) || /^sequence$/i.test(lines[0]))) { const l = lines.shift(); if (/^sequence$/i.test(l)) seq = true; else titles.push(l); }
    lines.unshift(...titles);
    return seq ? sequence(lines) : flow(lines);
  }

  // ---- export helpers (browser): copy or save a diagram/chart as SVG or PNG ----
  // A standalone SVG has no page CSS, so currentColor and var(--bg) are resolved to real colours first.
  function standalone(svgEl, color, bg) {
    const c = svgEl.cloneNode(true);
    c.setAttribute('color', color || '#1d1d1f'); c.removeAttribute('style');
    let s = new XMLSerializer().serializeToString(c).replace(/var\(--bg,#fff\)/g, bg || '#ffffff').replace(/var\(--bg\)/g, bg || '#ffffff');
    return { svg: s, w: svgEl.viewBox.baseVal.width || svgEl.clientWidth, h: svgEl.viewBox.baseVal.height || svgEl.clientHeight };
  }
  function toPngBlob(svgEl, color, bg, scale = 2) {
    const { svg, w, h } = standalone(svgEl, color, bg);
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas'); cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
        const g = cv.getContext('2d'); g.fillStyle = bg || '#ffffff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob((b) => (b ? res(b) : rej(new Error('PNG failed'))), 'image/png');
      };
      img.onerror = () => rej(new Error('could not draw the diagram'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  const api = { render, standalone, toPngBlob, parseNode, colorOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PNDiagram = api;
})(typeof window !== 'undefined' ? window : globalThis);
