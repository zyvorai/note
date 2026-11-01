#!/usr/bin/env node
// Cross-platform desktop launcher (Windows, Linux, macOS).
// Starts the notes server on localhost and opens it in a standalone app window using an installed
// Chromium-based browser (Chrome, Edge, Chromium, Brave) in --app mode. Falls back to your default browser.
// Closing the window stops the server.
//
//   plainnote [--notes DIR] [--port N] [--no-window]
//   env: PLAINNOTE_DIR, PLAINNOTE_BROWSER (path to a browser), PLAINNOTE_BROWSER_ARGS

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const { listen } = typeof __bundled !== 'undefined' ? __bundled : require('../server.js');   // __bundled: single-file build
const PREFERRED_PORT = 47877;     // stable port so the window's saved settings (origin) survive restarts

function parseArgs(argv) {
  const o = { notes: process.env.PLAINNOTE_DIR || path.join(os.homedir(), 'Notes'), port: PREFERRED_PORT, window: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notes') o.notes = argv[++i];
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--no-window') o.window = false;
    else if (a === '-h' || a === '--help') { console.log('Usage: plainnote [--notes DIR] [--port N] [--no-window]'); process.exit(0); }
  }
  return o;
}

function findBrowser() {
  const env = process.env.PLAINNOTE_BROWSER;
  if (env) return fs.existsSync(env) ? env : null;
  const p = process.platform, e = process.env;
  const candidates = p === 'win32' ? [
    `${e['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, `${e.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${e.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`, `${e['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${e.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, `${e.ProgramFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  ] : p === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : [];
  for (const c of candidates) if (c && !c.includes('undefined') && fs.existsSync(c)) return c;
  if (p === 'linux') {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
      try { const r = execFileSync('which', [n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (r) return r; } catch {}
    }
  }
  return null;
}

function openDefault(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

const probe = (port) => new Promise((resolve) => {     // is a Plainnote server already on this port?
  const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d).app === 'plainnote'); } catch { resolve(false); } });
  });
  req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
});

function appWindow(browser, url) {
  const profile = path.join(os.homedir(), '.plainnote', 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const extra = (process.env.PLAINNOTE_BROWSER_ARGS || '').split(' ').filter(Boolean);
  return spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1100,720', ...extra],
    { stdio: 'ignore' });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const browser = opts.window ? findBrowser() : null;
  let lastPing = 0, pinged = false;
  const hooks = { onPing: () => { lastPing = Date.now(); pinged = true; } };

  let started;
  try { started = await listen(opts.notes, opts.port, hooks); }
  catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    if (opts.port === PREFERRED_PORT && (await probe(opts.port))) {          // already running: just open another window
      const url = `http://127.0.0.1:${opts.port}/`;
      if (browser) appWindow(browser, url).unref?.(); else openDefault(url);
      console.log(`Plainnote is already running: ${url}`);
      return;
    }
    started = await listen(opts.notes, 0, hooks);
  }
  const url = `http://127.0.0.1:${started.port}/`;
  console.log(`Plainnote\n  notes: ${started.root}\n  open:  ${url}`);

  const quit = () => { try { started.server.close(); } catch {} process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);

  if (!browser) {
    if (opts.window) { console.log('No Chrome/Edge/Chromium found; opening your default browser. Press Ctrl+C to quit.'); openDefault(url); }
    else console.log('Press Ctrl+C to quit.');
    return;
  }
  const child = appWindow(browser, url);
  child.on('error', (e) => { console.error('Could not start browser:', e.message); openDefault(url); });
  child.on('exit', quit);                                              // window closed -> stop the server
  // Safety net: if the window's process lingers (some platforms keep the browser alive) quit once pings stop.
  setInterval(() => { if (pinged && Date.now() - lastPing > 180000) { try { child.kill(); } catch {} quit(); } }, 15000).unref();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
