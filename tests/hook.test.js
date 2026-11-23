// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

// The pre-push hook runs the tests before a push, and stays out of the way when there is nothing to test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'git-hooks', 'pre-push'), ZERO = '0'.repeat(40), SHA = 'a'.repeat(40);
const run = (lines, env = {}) => spawnSync('sh', [HOOK], { input: lines.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, SKIP_TESTS: '', ...env }, cwd: path.join(__dirname, '..') });
const push = `refs/heads/feature ${SHA} refs/heads/feature ${ZERO}`;

test('a push that sends commits runs the command, and a failure stops the push', () => {
  const ok = run([push], { PRE_PUSH_TEST_CMD: 'echo suite ran' }); assert.equal(ok.status, 0); assert.match(ok.stdout, /running the tests/); assert.match(ok.stdout, /suite ran/);
  const bad = run([push], { PRE_PUSH_TEST_CMD: 'echo nope; exit 3' }); assert.equal(bad.status, 1); assert.match(bad.stdout, /nothing was pushed/);
});
test('it stays out of the way for deletions and tags, and can be skipped once', () => {
  const fail = { PRE_PUSH_TEST_CMD: 'exit 1' };
  assert.equal(run([`(delete) ${ZERO} refs/heads/old ${SHA}`], fail).status, 0, 'deleting a branch needs no tests');
  assert.equal(run([`refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}`], fail).status, 0, 'pushing only a tag needs no tests');
  assert.equal(run([`(delete) ${ZERO} refs/heads/old ${SHA}`, push], fail).status, 1, 'a mixed push still runs them');
  const skip = run([push], { ...fail, SKIP_TESTS: '1' }); assert.equal(skip.status, 0); assert.match(skip.stdout, /not running the tests/);
});
test('it is executable, installed by one npm script, and only looks at the repository it is in', () => {
  if (process.platform !== 'win32') assert.ok(fs.statSync(HOOK).mode & 0o111, 'the hook file is executable');   // Windows has no exec bit
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts['setup-hooks'], 'git config core.hooksPath scripts/git-hooks');
  if (process.platform === 'win32') return;                       // Git Bash prints /d/a/… for D:\a\…
  const here = run([push], { PRE_PUSH_TEST_CMD: 'pwd' }); assert.equal(here.stdout.trim().split('\n').pop(), fs.realpathSync(path.join(__dirname, '..')), 'it runs from the repository root');
});
