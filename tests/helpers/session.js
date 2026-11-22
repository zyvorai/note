// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// Shared harness for the real-browser tests: a Plainnote server on a throwaway folder plus headless Chrome driven over the DevTools protocol.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));

// session({ files: { 'Note.md': 'text' }, env, size: [w, h], mobile }) -> { dir, port, base, ev, until, key, cdp, errors, reload, stopServer, startServer, close }
async function session(opts = {}) {
  const dir = mk('pn-sess-v-'), prof = mk('pn-sess-p-');
  for (const [rel, data] of Object.entries(opts.files || {})) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); }
  const [port, dport] = [await free(), await free()];
  let server;
  const startServer = async () => {
    server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js'), dir, String(port)], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...(opts.env || {}) } });
    await new Promise((res, rej) => { server.stdout.on('data', (d) => /Open:/.test(d) && res()); server.once('exit', (c) => rej(new Error('the test server exited early (code ' + c + '); is its port still in use?'))); });
  };
  await startServer();
  const [w, h] = opts.size || [1200, 800];
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${dport}`, `--user-data-dir=${prof}`, `--window-size=${w},${h}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${dport}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(250); }
  if (!target) throw new Error('chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(), errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Page.javascriptDialogOpening') { ws.send(JSON.stringify({ id: 900000 + (id++), method: 'Page.handleJavaScriptDialog', params: { accept: true } })); return; } if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
  const until = async (expr, what, tries = 80) => { for (let i = 0; i < tries; i++) { if (await ev(expr)) return; await sleep(120); } throw new Error('timeout: ' + what); };
  const keyCodes = { Tab: 9, Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, ' ': 32 };
  const key = async (k, mods = {}) => { const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0); for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: keyCodes[k] || k.toUpperCase().charCodeAt(0), modifiers, text: type === 'rawKeyDown' && k.length === 1 && !modifiers ? k : undefined }); };
  const typeInto = (sel, text) => ev(`(()=>{const i=document.querySelector(${JSON.stringify(sel)});i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await cdp('Runtime.enable'); await cdp('Page.enable');
  if (opts.mobile) await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  const reload = async () => { await cdp('Page.navigate', { url: `http://localhost:${port}/` }); await sleep(1500); await ev("localStorage.tourSeen='1'"); };
  await reload();
  return {
    dir, port, base: `http://localhost:${port}`, ev, until, key, cdp, typeInto, errors, reload, sleep,
    read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'), exists: (rel) => fs.existsSync(path.join(dir, rel)),
    stopServer: () => server.kill(), startServer,
    close: () => { try { ws.close(); } catch {} chrome.kill(); server.kill(); },
  };
}
module.exports = { session, CHROME, sleep, mk };
