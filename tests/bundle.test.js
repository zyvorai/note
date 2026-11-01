// The single-file executable is built from a generated bundle; check that bundle works under plain Node.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('generated single-file bundle serves the app', async () => {
  const root = path.join(__dirname, '..');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-sea.js'), '--bundle-only'], { cwd: root, stdio: 'pipe' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainnote-b-'));
  const proc = spawn(process.execPath, [path.join(root, 'dist', 'sea', 'bundle.js'), '--notes', dir, '--port', '0', '--no-window'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const url = await new Promise((res, rej) => { let o = ''; proc.stdout.on('data', (d) => { o += d; const m = o.match(/open:\s+(\S+)/); if (m) res(m[1]); }); proc.on('exit', () => rej(new Error('exited: ' + o))); });
    assert.match(await (await fetch(url)).text(), /<title>Plainnote<\/title>/);
    assert.equal((await fetch(url + 'api/notes')).status, 200);
  } finally { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
