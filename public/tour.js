// First-run experience: sample notes you can create with one click, and a short spotlight tour of the app.
// Starts by itself only for an empty notes folder that has never seen it; anyone can run it from the command palette.
(function () {
  'use strict';
  const SEEN = 'tourSeen';
  const seen = () => { try { return localStorage.getItem(SEEN) === '1'; } catch { return true; } };
  const markSeen = () => { try { localStorage.setItem(SEEN, '1'); } catch {} };
  const mod = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';

  // Sample notes: only mention features this build has, so nothing in them renders as raw code.
  function samples() {
    const has = { math: typeof MD.mathml === 'function', chart: typeof MD.chartSvg === 'function' };
    const diagram = '```diagram\nIdea -> Draft -> Review -> Publish\nReview --> Draft: changes\n```';
    const rich = [
      '## Diagrams\n\nA fenced block named `diagram` draws a flow chart:\n\n' + diagram,
      has.math ? '## Math\n\nWrite LaTeX between dollar signs: $e^{i\\pi}+1=0$. For a display equation use two on their own lines:\n\n$$\n\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\n$$' : '',
      has.chart ? '## Charts\n\n```chart\nbar\ntitle: Notes written\nMon: 3\nTue: 5\nWed: 8\nThu: 6\n```' : '',
    ].filter(Boolean).join('\n\n');
    return [
      { name: 'Welcome', text: `# Welcome to Plainnote\n\nYour notes are **plain Markdown files** in a folder you own. Nothing is uploaded, and there is no account.\n\nThese sample notes show what it can do. Delete them whenever you like.\n\n- [[Writing in Markdown]]: headings, lists, tasks, tables and code\n- [[Links and the graph]]: connect notes and see how they relate\n- [[Diagrams and more]]: diagrams${has.math ? ', math' : ''}${has.chart ? ', charts' : ''}\n- [[Your files]]: where everything lives, sync and attachments\n\n## Try this now\n\n- [ ] Press **${mod}+K** and type a few letters to jump to a note\n- [ ] Press **${mod}+E** to switch between writing and reading\n- [ ] Press **${mod}+G** to open the graph\n- [ ] Press **${mod}+Shift+P** for the command palette\n\n#welcome\n` },
      { name: 'Getting started/Writing in Markdown', text: `# Writing in Markdown\n\n## Basics\n\nUse **bold**, *italic*, ~~strikethrough~~ and \`inline code\`.\n\n> A quote. Start a line with \`>\`.\n\n- Bullets start with \`-\`\n  - Indent for nesting\n1. Numbers work too\n\n- [ ] Tasks use \`- [ ]\`\n- [x] and \`- [x]\` when done (click one in the reading view)\n\n## Tables and code\n\n| Shortcut | Does |\n|---|---|\n| ${mod}+K | Jump or create |\n| ${mod}+N | New note |\n\n\`\`\`js\nconst note = 'plain text';\n\`\`\`\n\nBack to [[Welcome]].\n\n#welcome\n` },
      { name: 'Getting started/Links and the graph', text: `# Links and the graph\n\nType two square brackets to link to another note: [[Welcome]] or [[Writing in Markdown]]. A link to a note that does not exist yet, like [[My first idea]], is shown differently, and clicking it creates the note.\n\nEvery link appears as a **backlink** on the note it points to, and ${mod}+G shows the whole web of notes as a graph.\n\n## Tags\n\nWrite #ideas or #projects anywhere in a note. Click a tag in the sidebar to filter.\n\n## Embeds\n\nShow another note inside this one with \`![[Name]]\`:\n\n![[Welcome]]\n\n#welcome\n` },
      { name: 'Getting started/Diagrams and more', text: `# Diagrams and more\n\n${rich}\n\nBack to [[Welcome]].\n\n#welcome\n` },
      { name: 'Getting started/Your files', text: `# Your files\n\nEvery note is a \`.md\` file in your notes folder, so any editor, backup tool or script can use them. You can point Plainnote at an existing folder of Markdown, including an Obsidian vault.\n\n- **Images and PDFs**: paste or drop them into a note; they are saved in \`attachments/\` next to your notes.\n- **Sync**: the sidebar footer syncs the folder with a git remote.\n- **Export**: the command palette has *Export this note as PDF* and *as HTML*.\n- **Phones**: start the server in remote mode to use it from your phone.\n\nBack to [[Welcome]].\n\n#welcome\n` },
    ];
  }

  async function createSamples(openAfter) {
    let made = 0;
    for (const n of samples()) {
      try { await api('/api/note?name=' + encodeURIComponent(n.name), { method: 'PUT', headers: { 'x-base-mtime': '0' }, body: n.text }); made++; }
      catch (e) { if (e.message !== 'conflict') throw e; }            // never overwrite a note you already have
    }
    await load();
    if (made && openAfter) await open('Welcome', false);
    say(made ? `Added ${made} sample note${made === 1 ? '' : 's'}` : 'The sample notes are already there');
    return made;
  }

  const STEPS = () => [
    { title: 'Welcome to Plainnote', body: 'Notes that feel instant, stored as plain Markdown files you own. This 60-second tour shows where things are.', sample: true },
    { sel: '#q', title: 'Search everything', body: `Type here to search every note. ${mod}+K jumps straight to a note or creates it.` },
    { sel: '#new', title: 'New note', body: `Start a note with + or ${mod}+N. “Today” opens a daily note.` },
    { sel: '#tog', title: 'Write, then read', body: `${mod}+E switches between writing Markdown and the clean reading view.` },
    { sel: '#gr', title: 'See how ideas connect', body: `Link notes with [[double brackets]]. The graph (${mod}+G) draws every link, and backlinks appear on each note.` },
    { title: 'Everything else is in the palette', body: `Press ${mod}+Shift+P for the command palette: history, templates, export to PDF, import, the web clipper and more. You can take this tour again from there.`, last: true },
  ];

  let ui = null;
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && getComputedStyle(el).visibility !== 'hidden'; };

  function stop(markDone = true) {
    if (!ui) return; ui.root.remove(); document.removeEventListener('keydown', ui.onKey, true); removeEventListener('resize', ui.place); ui = null;
    if (markDone) markSeen();
  }

  async function start() {
    stop(false);
    const empty = !notes.size, steps = STEPS(); let i = 0;
    const root = document.createElement('div'); root.id = 'tour';
    root.innerHTML = '<div class="thl"></div><div class="tcard" role="dialog" aria-modal="true" aria-labelledby="ttl" tabindex="-1"><h3 id="ttl"></h3><p id="tbd"></p><div class="tact"></div><div class="tdots" aria-hidden="true"></div></div>';
    document.body.appendChild(root);
    const hl = root.querySelector('.thl'), card = root.querySelector('.tcard'), act = root.querySelector('.tact');
    const place = () => {
      const s = steps[i], el = s.sel && document.querySelector(s.sel);
      if (el && visible(el)) {
        const r = el.getBoundingClientRect(), pad = 6;
        root.classList.remove('center');
        Object.assign(hl.style, { display: 'block', left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
        const cw = Math.min(320, innerWidth - 24), below = r.bottom + 14 + card.offsetHeight < innerHeight;
        card.style.width = cw + 'px'; card.style.transform = 'none';
        card.style.left = Math.max(12, Math.min(innerWidth - cw - 12, r.left)) + 'px';
        card.style.top = (below ? r.bottom + 14 : Math.max(12, r.top - 14 - card.offsetHeight)) + 'px';
      } else {                                                         // hidden on this layout (e.g. the sidebar on a phone): centre the card
        root.classList.add('center'); hl.style.display = 'none'; card.style.width = Math.min(360, innerWidth - 24) + 'px';
        card.style.left = '50%'; card.style.top = '50%'; card.style.transform = 'translate(-50%,-50%)';
      }
    };
    const show = () => {
      const s = steps[i]; root.querySelector('#ttl').textContent = s.title; root.querySelector('#tbd').textContent = s.body;
      act.innerHTML = '';
      const btn = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; act.appendChild(b); return b; };
      btn('Skip', () => stop(), 'tskip');
      if (s.sample) {
        if (empty) btn('Add sample notes', async () => { await createSamples(true); i++; show(); }, 'pri');
      } else if (i > 0) btn('Back', () => { i--; show(); });
      const next = btn(s.last ? 'Done' : s.sample && empty ? 'Just the tour' : 'Next', () => { if (s.last) stop(); else { i++; show(); } }, s.sample && empty ? '' : 'pri');
      root.querySelector('.tdots').innerHTML = steps.map((_, k) => `<span${k === i ? ' class="on"' : ''}></span>`).join('');
      place(); (s.sample && empty ? act.children[1] : next).focus();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
      else if (e.key === 'ArrowRight' && i < steps.length - 1) { e.preventDefault(); e.stopPropagation(); i++; show(); }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); e.stopPropagation(); i--; show(); }
    };
    document.addEventListener('keydown', onKey, true); addEventListener('resize', place);
    ui = { root, onKey, place }; show();
  }

  // Run once for a brand-new, empty notes folder (never for people who already have notes, and not in screenshot modes).
  function maybeStart() { if (!seen() && !notes.size && !/[?&](graph|preview)\b/.test(location.search)) start(); }

  window.PNTour = { start, stop, createSamples, samples, maybeStart, seen };
})();
