#!/usr/bin/env node
// Renders the marketing screenshots in docs/assets/ from a fixed set of sample notes (headless Chrome, no dependencies).
// Usage: node scripts/screenshots.js [outDir]
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
const { listen } = require('../server.js');

const NOTES = {
  'Plainnote': `# Plainnote
A fast, private notes app that keeps everything as **plain Markdown** files. No account, no cloud, no lock-in.

#product #local-first

## Why you'll like it
- [x] Your notes are just \`.md\` files in a folder you choose
- [x] Link ideas with [[Wikilinks]] and see how they connect in the [[Graph View]]
- [x] Works offline, starts instantly, uses almost no memory
- [ ] Sync with git when you want to — see [[Sync]]

## At a glance
| Feature | Plainnote | Typical notes app |
|---|---|---|
| Install size | **~100 MB** single file | 400 MB+ |
| Startup | instant | seconds |
| Your data | plain text files | proprietary database |
| Price | free forever | subscription |

## Try it
\`\`\`js
// every note is a file you can read anywhere
const note = fs.readFileSync('Plainnote.md', 'utf8');
console.log(note.split('\\n')[0]); // "# Plainnote"
\`\`\`

> Write in the open, think in links. See also [[Daily Notes]] and [[Ideas]].
`,
  'Wikilinks': '# Wikilinks\nType `[[` to link any note. Backlinks appear below every note automatically.\n\n#writing\n\nSee [[Plainnote]], [[Graph View]], [[Zettelkasten]].\n',
  'Graph View': '# Graph View\nSee your whole knowledge base as a living map. Drag, zoom, click a node to open it.\n\n#thinking\n\nBuilt on [[Wikilinks]] and [[Tags]].\n',
  'Tags': '# Tags\nUse #ideas or #project/alpha anywhere in a note and filter from the sidebar.\n\nRelated: [[Plainnote]], [[Search]].\n',
  'Search': '# Search\nFull-text search with snippets, plus a quick switcher on Ctrl/Cmd+K.\n\nLinks: [[Tags]], [[Command Palette]].\n',
  'Command Palette': '# Command Palette\nPress Ctrl/Cmd+Shift+P to run any action.\n\n#shortcuts\n\nSee [[Search]], [[Plainnote]].\n',
  'Sync': '# Sync\nOptional git sync keeps notes backed up and shared between machines.\n\n#local-first\n\n[[Plainnote]] never needs a server.\n',
  'Daily Notes': '# Daily Notes\nOne click for today\'s page.\n\n- [x] Plan the week\n- [ ] Write the launch post\n\n[[Plainnote]] · [[Ideas]]\n',
  'Ideas': '# Ideas\n- Weekly review template\n- Reading list with ratings\n- Public garden export\n\n#ideas\n\n[[Zettelkasten]] · [[Daily Notes]]\n',
  'Zettelkasten': '# Zettelkasten\nSmall atomic notes, densely linked.\n\n#thinking\n\n[[Wikilinks]], [[Ideas]], [[Graph View]].\n',
  'Reading List': '# Reading List\n| Book | Status |\n|---|---|\n| How to Take Smart Notes | done |\n| The Pragmatic Programmer | reading |\n\n#books\n\n[[Ideas]]\n',
  'Themes': '# Themes\nLight, dark or automatic. Press Ctrl/Cmd+Shift+L to cycle.\n\n[[Plainnote]]\n',
};

function chrome() {
  const c = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}

(async () => {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs', 'assets'));
  const bin = chrome(); if (!bin) { console.error('Chrome/Chromium not found (set CHROME=...)'); process.exit(1); }
  fs.mkdirSync(out, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-shots-'));
  const now = Date.now();
  Object.entries(NOTES).forEach(([name, text], i) => {
    const f = path.join(dir, name + '.md'); fs.writeFileSync(f, text);
    const t = new Date(now - i * 3600e3); fs.utimesSync(f, t, t);          // stable "recent first" ordering
  });
  const { server, port } = await listen(dir, 0);
  const base = `http://127.0.0.1:${port}`;
  const shots = [
    ['hero-light', '/?preview#Plainnote', 0, 1440, 900], ['hero-dark', '/?preview#Plainnote', 1, 1440, 900],
    ['graph-light', '/?graph&settle#Plainnote', 0, 1440, 900], ['graph-dark', '/?graph&settle#Plainnote', 1, 1440, 900],
    ['edit-dark', '/#Plainnote', 1, 1440, 900],
  ];
  for (const [name, url, dark, w, h] of shots) {
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-prof-'));
    const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${prof}`, `--window-size=${w},${h}`,
      '--force-device-scale-factor=2', `--blink-settings=preferredColorScheme=${dark ? 0 : 1}`, '--virtual-time-budget=6000',
      `--screenshot=${path.join(out, name + '.png')}`, base + url];
    await new Promise((resolve) => {                       // async: the server runs in this process and must keep answering
      const c = spawn(bin, args, { stdio: 'ignore' }), t = setTimeout(() => c.kill(), 60000);
      c.on('exit', () => { clearTimeout(t); resolve(); });
    });
    fs.rmSync(prof, { recursive: true, force: true });
    console.log(name, fs.existsSync(path.join(out, name + '.png')) ? 'ok' : 'FAILED');
  }
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
})();
