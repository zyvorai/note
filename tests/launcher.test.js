const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LAUNCHER = path.join(__dirname, '..', 'desktop', 'launcher.js');
const posix = process.platform !== 'win32';

function run(args, env = {}) {
  const proc = spawn(process.execPath, [LAUNCHER, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  const url = new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => { out += d; const m = out.match(/open:\s+(http:\/\/127\.0\.0\.1:\d+\/)/); if (m) resolve(m[1]); });
    proc.on('exit', () => reject(new Error('exited before printing a URL: ' + out)));
  });
  return { proc, url, exited };
}

test('--no-window serves the app and stops on SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-l-'));
  const l = run(['--notes', dir, '--port', '0', '--no-window']);
  try {
    const url = await l.url;
    assert.deepEqual(await (await fetch(url + 'api/ping')).json(), { app: 'plainnote' });
    assert.match(await (await fetch(url)).text(), /Plainnote/);
    assert.match(await (await fetch(url + 'md.js')).text(), /createMarkdown|function create/);
    l.proc.kill('SIGTERM');
    assert.equal(await l.exited, 0);
    await assert.rejects(fetch(url + 'api/ping'));
  } finally { l.proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closing the app window stops the server', { skip: !posix && 'needs a POSIX shell' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-l-'));
  const fake = path.join(dir, 'fake-browser.sh');                       // stands in for Chrome: "window" lives 1.5 s
  fs.writeFileSync(fake, '#!/bin/sh\necho "$@" > "$(dirname "$0")/args.txt"\nsleep 1.5\n', { mode: 0o755 });
  const l = run(['--notes', path.join(dir, 'notes'), '--port', '0'], { PLAINNOTE_BROWSER: fake, HOME: dir, USERPROFILE: dir });
  try {
    const url = await l.url;
    assert.equal((await fetch(url + 'api/ping')).status, 200);
    assert.equal(await l.exited, 0);                                    // exits by itself once the "window" closes
    await assert.rejects(fetch(url + 'api/ping'));
    const args = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8');
    assert.ok(args.includes(`--app=${url}`) && args.includes('--user-data-dir='), args);
  } finally { l.proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
