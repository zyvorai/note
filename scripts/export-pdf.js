'use strict';
// Render a Markdown note to PDF using the app's own renderer and a locally installed Chromium-based browser.
const fs = require('fs'), os = require('os'), path = require('path'), { execFile } = require('child_process'), { pathToFileURL } = require('url');
const MD = require('../public/md.js');

const BROWSERS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const CSS = `body{font:13px/1.55 -apple-system,Helvetica,Arial,sans-serif;max-width:780px;margin:0 auto;color:#1f2328}
h1,h2{border-bottom:1px solid #d8dee4;padding-bottom:.3em}code{background:#f3f4f6;padding:.15em .35em;border-radius:4px}
pre{background:#f6f8fa;padding:12px;border-radius:6px;white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:5px 10px}
blockquote{border-left:4px solid #d0d7de;margin:0;padding:0 1em;color:#59636e}img{max-width:100%}.pdfembed{display:none}.math-block{margin:1em 0;text-align:center}`;

function toHtml(file, text, root) {
  const { md } = MD.create({ resolve: () => null, embed: () => '' });
  // /files/<path> URLs are relative to the notes root; point them at the real files so images load
  const body = md(text).replace(/(src|href)="\/files\//g, `$1="${pathToFileURL(root + path.sep).href}`);
  return `<!doctype html><meta charset="utf-8"><title>${path.basename(file, '.md')}</title><style>${CSS}</style>${body}`;
}

async function run(args) {
  const [input, output] = args;
  if (!input) throw new Error('usage: node server.js export <note.md> [out.pdf]');
  const file = path.resolve(input), out = path.resolve(output || file.replace(/\.md$/i, '') + '.pdf');
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
  if (/^\s*-----BEGIN PLAINNOTE ENCRYPTED NOTE-----/.test(fs.readFileSync(file, 'utf8'))) throw new Error('This note is encrypted. Unlock it in Plainnote and use Export there, or remove its encryption first.');
  const browser = BROWSERS.find((b) => fs.existsSync(b));
  if (!browser) throw new Error('No Chrome/Edge/Chromium found. Install one, or set CHROME=/path/to/browser.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-'));
  const html = path.join(tmp, 'note.html');
  fs.writeFileSync(html, toHtml(file, fs.readFileSync(file, 'utf8'), path.dirname(file)));
  try {
    await new Promise((res, rej) => execFile(browser, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--allow-file-access-from-files',
      `--user-data-dir=${path.join(tmp, 'profile')}`, `--print-to-pdf=${out}`, pathToFileURL(html).href], { timeout: 60000 }, (e) => (e ? rej(e) : res())));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (!fs.existsSync(out)) throw new Error('PDF was not produced');
  return out;
}
module.exports = { run, toHtml };
