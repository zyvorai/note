#!/usr/bin/env node
// Builds a single-file executable (no Node install needed) for the CURRENT platform:
//   node scripts/build-sea.js   ->  dist/plainnote-<platform>-<arch>[.exe]
// Needs a Node build with SEA support (official nodejs.org / actions/setup-node builds; Homebrew's lacks it).
// Uses Node's Single Executable Applications + postject. Run it on each OS (see .github/workflows/release.yml).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'sea');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. One script: server.js wrapped as a module, then the launcher (SEA can only run a single file).
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/^#!.*\n/, '');
const launcher = fs.readFileSync(path.join(root, 'desktop', 'launcher.js'), 'utf8').replace(/^#!.*\n/, '');
fs.writeFileSync(path.join(out, 'bundle.js'),
  `const __bundled = (function () {\n  const module = { exports: {} };\n  (function (module, exports, require, __dirname) {\n${server}\n  })(module, module.exports, require, '');\n  return module.exports;\n})();\n${launcher}`);

if (process.argv.includes('--bundle-only')) { console.log('Wrote', path.relative(root, path.join(out, 'bundle.js'))); process.exit(0); }   // used by tests

// 2. Embed the UI files.
const assets = {};
for (const f of fs.readdirSync(path.join(root, 'public'))) assets[f] = path.join(root, 'public', f);
fs.writeFileSync(path.join(out, 'sea-config.json'), JSON.stringify({
  main: path.join(out, 'bundle.js'), output: path.join(out, 'sea.blob'), disableExperimentalSEAWarning: true, assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(out, 'sea-config.json')], { stdio: 'inherit' });

// 3. Copy this machine's node binary and inject the blob.
const win = process.platform === 'win32', mac = process.platform === 'darwin';
const exe = path.join(root, 'dist', `plainnote-${process.platform}-${process.arch}${win ? '.exe' : ''}`);
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (mac) try { execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' }); } catch {}
const postject = ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', path.join(out, 'sea.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(mac ? ['--macho-segment-name', 'NODE_SEA'] : [])];
execFileSync(win ? 'npx.cmd' : 'npx', postject, { stdio: 'inherit', shell: win });
if (mac) execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
console.log('Built', path.relative(root, exe));
