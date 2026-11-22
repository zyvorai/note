// Copyright 2026 Zyvor AI Labs · https://zyvor.dev
// SPDX-License-Identifier: LicenseRef-Zyvor-Production-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const nc = require('node:crypto');
const C = require('../public/crypto.js');

test('round trip, unicode, empty text and fresh IV on every save', async () => {
  const { envelope, session } = await C.encryptWithPassphrase('# Secret ✓ ünïcode 😀\n\nbody', 'correct horse battery');
  assert.ok(C.isEnvelope(envelope)); assert.ok(!envelope.includes('Secret'));
  const d = await C.decrypt(envelope, 'correct horse battery'); assert.equal(d.text, '# Secret ✓ ünïcode 😀\n\nbody');
  const again = await C.encrypt(d.text, d.session);                                  // later saves reuse the key but never the IV
  assert.notEqual(again, envelope); assert.equal((await C.decrypt(again, session)).text, d.text);
  const empty = await C.encrypt('', session); assert.equal((await C.decrypt(empty, 'correct horse battery')).text, '');
  const big = 'x'.repeat(300000); assert.equal((await C.decrypt(await C.encrypt(big, session), session)).text, big);
});

test('wrong passphrase, tampering and bad headers are all refused', async () => {
  const { envelope } = await C.encryptWithPassphrase('top secret', 'passphrase one');
  await assert.rejects(C.decrypt(envelope, 'passphrase two'), /Wrong passphrase/);
  const flip = (s, find, rep) => { assert.ok(s.includes(find)); return s.replace(find, rep); };
  const body = envelope.split('\n\n')[1].split('\n')[0];
  await assert.rejects(C.decrypt(flip(envelope, body, (body[0] === 'A' ? 'B' : 'A') + body.slice(1)), 'passphrase one'), /Wrong passphrase|not a valid/);   // ciphertext changed
  await assert.rejects(C.decrypt(envelope.replace(/IV: .{16}/, (m) => m.slice(0, 4) + (m[4] === 'A' ? 'B' : 'A') + m.slice(5)), 'passphrase one'), /Wrong passphrase/);          // IV changed
  await assert.rejects(C.decrypt(flip(envelope, 'Iterations: 600000', 'Iterations: 600001'), 'passphrase one'), /Wrong passphrase/);                                            // iterations changed
  await assert.rejects(C.decrypt(flip(envelope, 'Iterations: 600000', 'Iterations: 99999999999'), 'passphrase one'), /unreasonable/);                                           // a crafted file cannot demand hours of work
  await assert.rejects(C.decrypt(flip(envelope, 'Iterations: 600000', 'Iterations: 10'), 'passphrase one'), /unreasonable/);
  await assert.rejects(C.decrypt(flip(envelope, 'Version: 1', 'Version: 2'), 'passphrase one'), /format/);
  await assert.rejects(C.decrypt(flip(envelope, 'AES-256-GCM', 'AES-128-GCM'), 'passphrase one'), /format/);
  await assert.rejects(C.decrypt('hello', 'x'), /not a valid/); await assert.rejects(C.decrypt(envelope.replace(C.END, ''), 'passphrase one'), /not a valid/);
  await assert.rejects(C.decrypt(envelope.replace(/Salt: .*/, 'Salt: AAAA'), 'passphrase one'), /not a valid/);
  await assert.rejects(C.encryptWithPassphrase('x', 'short'), /at least 8/);
  assert.ok(!C.isEnvelope('# normal note')); assert.ok(C.isEnvelope('\n  ' + envelope));
});

test('the format is standard: an independent implementation (node:crypto) opens it, and the reverse', async () => {
  const pass = 'ünï passphrase ✓';
  const { envelope } = await C.encryptWithPassphrase('written by Plainnote', pass);
  const lines = envelope.trim().split('\n'), h = Object.fromEntries(lines.slice(1, 7).map((l) => l.split(': ')));
  const ct = Buffer.from(lines.slice(8, -1).join(''), 'base64'), key = nc.pbkdf2Sync(pass.normalize('NFKC'), Buffer.from(h.Salt, 'base64'), +h.Iterations, 32, 'sha256');
  const dec = nc.createDecipheriv('aes-256-gcm', key, Buffer.from(h.IV, 'base64')); dec.setAAD(Buffer.from('plainnote-enc-v1')); dec.setAuthTag(ct.subarray(-16));
  assert.equal(Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]).toString('utf8'), 'written by Plainnote');
  // …and a note produced entirely outside Plainnote opens in it
  const salt = nc.randomBytes(16), iv = nc.randomBytes(12), k = nc.pbkdf2Sync('outside pass', salt, 600000, 32, 'sha256'), c = nc.createCipheriv('aes-256-gcm', k, iv); c.setAAD(Buffer.from('plainnote-enc-v1'));
  const enc = Buffer.concat([c.update('made elsewhere', 'utf8'), c.final(), c.getAuthTag()]);
  const text = `${C.BEGIN}\nVersion: 1\nKDF: PBKDF2-SHA256\nIterations: 600000\nCipher: AES-256-GCM\nSalt: ${salt.toString('base64')}\nIV: ${iv.toString('base64')}\n\n${enc.toString('base64')}\n${C.END}\n`;
  assert.equal((await C.decrypt(text, 'outside pass')).text, 'made elsewhere');
});

test('passphrases are normalised (NFKC), so the same text typed differently still opens the note', async () => {
  const { envelope } = await C.encryptWithPassphrase('n', 'café passphrase');
  assert.equal((await C.decrypt(envelope, 'café passphrase')).text, 'n');         // é precomposed vs e + combining accent
});
