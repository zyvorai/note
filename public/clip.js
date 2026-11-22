// Web clipper: turns a page's HTML into Markdown and saves it as a note. Opened as a popup by the bookmarklet
// (see "Web clipper" in the command palette); the page's HTML arrives over postMessage and is parsed inertly (DOMParser).
(function () {
  'use strict';
  const SKIP = /^(script|style|noscript|template|svg|canvas|iframe|form|nav|footer|aside|button|select|input|textarea|dialog|head|audio|video|object|embed)$/;
  const NOISE = new Set(['nav', 'navbar', 'menu', 'sidebar', 'cookie', 'cookies', 'banner', 'advert', 'ads', 'ad', 'promo', 'share', 'sharing', 'social', 'comments', 'related', 'newsletter', 'subscribe', 'popup', 'modal', 'breadcrumb', 'breadcrumbs', 'skip']);
  const noisy = (n) => `${n.getAttribute('class') || ''} ${n.getAttribute('id') || ''}`.toLowerCase().split(/[\s_-]+/).some((t) => NOISE.has(t));
  const abs = (u, base) => { try { const x = new URL(u, base); return /^(https?:|mailto:)$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };

  function htmlToMd(root, base, keep) {
    const pres = [];
    const wrap = (s, m) => { const lead = /^\s*/.exec(s)[0], trail = /\s*$/.exec(s)[0], core = s.trim(); return core ? `${lead}${m}${core}${m}${trail}` : s; };
    function conv(n, ctx) {
      if (n.nodeType === 3) return n.nodeValue.replace(/[ \t\r\n\f]+/g, ' ');
      if (n.nodeType !== 1) return '';
      const t = n.nodeName.toLowerCase();
      if (SKIP.test(t) || n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') return '';
      if (!keep && n !== root && !/^(html|body|article|main)$/.test(t) && noisy(n)) return '';
      const kids = () => [...n.childNodes].map((c) => conv(c, ctx)).join('');
      switch (t) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': { const x = kids().replace(/\s+/g, ' ').trim(); return x ? `\n\n${'#'.repeat(+t[1])} ${x}\n\n` : ''; }
        case 'p': { const x = kids().trim(); return x ? `\n\n${x}\n\n` : ''; }
        case 'br': return '\n';
        case 'hr': return '\n\n---\n\n';
        case 'strong': case 'b': return wrap(kids(), '**');
        case 'em': case 'i': return wrap(kids(), '*');
        case 'del': case 's': case 'strike': return wrap(kids(), '~~');
        case 'mark': return wrap(kids(), '==');
        case 'code': { const x = n.textContent.replace(/\n/g, ' '); if (!x.trim()) return ''; const f = '`'.repeat((x.match(/`+/g) || ['']).reduce((a, b) => Math.max(a, b.length), 0) + 1); return `${f}${/^`|`$/.test(x) ? ' ' + x + ' ' : x}${f}`; }
        case 'pre': {
          const c = n.querySelector('code'), cls = `${n.getAttribute('class') || ''} ${(c && c.getAttribute('class')) || ''}`, lang = (/(?:language|lang)-([\w+-]+)/.exec(cls) || [])[1] || '';
          const code = (c || n).textContent.replace(/\n+$/, '').replace(/^\n+/, '');
          pres.push('```' + lang + '\n' + code + '\n```'); return `\n\n\u0002${pres.length - 1}\u0002\n\n`;
        }
        case 'a': {
          const href = abs(n.getAttribute('href') || '', base), inner = kids().trim().replace(/\s+/g, ' ');
          return href && inner ? `[${inner.replace(/\]/g, '\\]')}](${href.replace(/\)/g, '%29')})` : inner;
        }
        case 'img': { const src = abs(n.getAttribute('src') || n.getAttribute('data-src') || '', base); return src ? `![${(n.getAttribute('alt') || '').replace(/[\[\]\n]/g, ' ').trim()}](${src.replace(/\)/g, '%29')})` : ''; }
        case 'ul': case 'ol': {
          const items = [...n.children].filter((c) => c.nodeName.toLowerCase() === 'li'); let i = +(n.getAttribute('start') || 1);
          const body = items.map((li) => `${t === 'ol' ? i++ + '.' : '-'} ${conv(li, ctx).trim().replace(/\n/g, '\n    ')}`).join('\n');
          return !body ? '' : n.parentNode && n.parentNode.nodeName.toLowerCase() === 'li' ? `\n${body}\n` : `\n\n${body}\n\n`;
        }
        case 'li': return kids();
        case 'blockquote': { const x = kids().trim().replace(/\n{3,}/g, '\n\n'); return x ? `\n\n${x.replace(/^/gm, '> ')}\n\n` : ''; }
        case 'figcaption': { const x = kids().trim(); return x ? `\n\n*${x}*\n\n` : ''; }
        case 'table': {
          const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].filter((c) => /^t[dh]$/i.test(c.nodeName)).map((c) => conv(c, ctx).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')));
          if (!rows.length || !rows[0].length) return '';
          const w = Math.max(...rows.map((r) => r.length)), line = (r) => `| ${Array.from({ length: w }, (_, k) => r[k] || '').join(' | ')} |`;
          return `\n\n${[line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n')}\n\n`;
        }
        case 'div': case 'section': case 'article': case 'main': case 'header': case 'figure': case 'details': case 'summary': case 'dl': case 'dt': case 'dd': case 'address': case 'tr': return `\n${kids()}\n`;
        default: return kids();
      }
    }
    let md = conv(root, {});
    md = md.replace(/[ \t]+$/gm, '').replace(/^ {1,3}(?=\S)/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return md.replace(/\u0002(\d+)\u0002/g, (_, i) => pres[+i]);
  }

  // Pick the part of a page worth keeping: a selection as-is, otherwise <article>/<main>, otherwise the body.
  function clip(html, base, wholePageHint) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = wholePageHint ? (doc.querySelector('article') || doc.querySelector('main, [role=main]') || doc.body) : doc.body;
    return htmlToMd(root, base, !wholePageHint);
  }
  const safeName = (s) => (s || 'Untitled clip').replace(/[\\/:*?"<>|#^\[\]\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled clip';
  const today = () => new Date().toISOString().slice(0, 10);
  function noteText(title, url, md) {
    const q = (s) => (/[:#"'\n]/.test(s) ? JSON.stringify(s) : s);
    const body = /^#\s/.test(md) ? md : `# ${title}\n\n${md}`;
    return `---\nsource: ${q(url)}\nclipped: ${today()}\ntags: clipping\n---\n\n${body}\n`;
  }
  // The bookmarklet: runs on the page being clipped, opens /clip.html on this server and hands it the selection (or the page) over postMessage.
  function bookmarklet(base) {
    const code = `(function(){var b=${JSON.stringify(base)},s=getSelection(),h='';
if(s&&s.rangeCount&&!s.isCollapsed){var d=document.createElement('div');for(var i=0;i<s.rangeCount;i++)d.appendChild(s.getRangeAt(i).cloneContents());h=d.innerHTML}
var m={t:'plainnote-clip',title:document.title,url:location.href,base:document.baseURI,sel:!!h,html:h||document.documentElement.outerHTML};
var w=window.open(b+'/clip.html','plainnote-clip','width=720,height=760');if(!w){alert('Allow pop-ups for this site to clip it.');return}
addEventListener('message',function f(e){if(e.origin===b&&e.data==='plainnote-clip-ready'){removeEventListener('message',f);w.postMessage(m,b)}})})()`;
    return 'javascript:' + encodeURIComponent(code.replace(/\n/g, ''));
  }
  const api = { htmlToMd, clip, safeName, noteText, bookmarklet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PNClip = api;

  // ---- popup page ----
  if (typeof document === 'undefined' || !document.getElementById('clip-form')) return;
  const $ = (id) => document.getElementById(id), status = (s, bad) => { $('st').textContent = s; $('st').className = bad ? 'bad' : ''; };
  let data = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window.opener || !e.data || e.data.t !== 'plainnote-clip' || typeof e.data.html !== 'string') return;   // only the page that opened us
    data = e.data;
    const title = String(data.title || 'Untitled clip');
    $('nm').value = 'Clippings/' + safeName(title);
    $('md').value = noteText(title, String(data.url || ''), clip(data.html, String(data.base || data.url || ''), !data.sel));
    $('waiting').hidden = true; $('clip-form').hidden = false; $('md').focus();
  });
  setTimeout(() => { if (!data) $('waiting').textContent = 'Nothing received. Click the Clip bookmark while viewing the page you want to save.'; }, 4000);
  try { window.opener.postMessage('plainnote-clip-ready', '*'); } catch { $('waiting').textContent = 'Open this window from the Clip bookmark, not directly.'; }
  $('clip-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('go').disabled = true;
    const base = safeName($('nm').value.replace(/^Clippings\//, '')), folder = /^Clippings\//.test($('nm').value) ? 'Clippings/' : '';
    try {
      for (let n = 1; ; n++) {                                        // x-base-mtime: 0 makes the server answer 409 when the note already exists, so nothing is overwritten
        const name = folder + base + (n > 1 ? ' ' + n : '');
        const r = await fetch('/api/note?name=' + encodeURIComponent(name), { method: 'PUT', headers: { 'x-base-mtime': '0' }, body: $('md').value });
        if (r.status === 409 && n < 50) continue;
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
        status(`Saved as “${name}”. You can close this window.`); $('clip-form').hidden = true; setTimeout(() => window.close(), 1500); return;
      }
    } catch (err) { status('Could not save: ' + err.message, true); $('go').disabled = false; }
  });
})();
