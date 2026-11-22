// Encrypted notes: AES-256-GCM with a key derived from your passphrase by PBKDF2-SHA256 (Web Crypto, nothing to install).
// An encrypted note is still a plain text file in your folder, in this armored format, so git sync and backups just work:
//
//   -----BEGIN PLAINNOTE ENCRYPTED NOTE-----
//   Version: 1
//   KDF: PBKDF2-SHA256
//   Iterations: 600000
//   Cipher: AES-256-GCM
//   Salt: <base64, 16 bytes>
//   IV: <base64, 12 bytes>
//
//   <base64 of ciphertext || 16-byte GCM tag, wrapped at 64 columns>
//   -----END PLAINNOTE ENCRYPTED NOTE-----
//
// key = PBKDF2-HMAC-SHA256(NFKC(passphrase) as UTF-8, Salt, Iterations) → 32 bytes; the GCM additional data is the ASCII text "plainnote-enc-v1".
// Anyone can decrypt a note with these facts alone (see the README); the plaintext is the note's UTF-8 text.
(function (root) {
  'use strict';
  const BEGIN = '-----BEGIN PLAINNOTE ENCRYPTED NOTE-----', END = '-----END PLAINNOTE ENCRYPTED NOTE-----';
  const ITER = 600000, MIN_ITER = 100000, MAX_ITER = 5000000, MIN_PASS = 8, AAD = new TextEncoder().encode('plainnote-enc-v1');
  const subtle = () => (root.crypto || require('node:crypto').webcrypto).subtle;
  const rand = (n) => (root.crypto || require('node:crypto').webcrypto).getRandomValues(new Uint8Array(n));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

  const isEnvelope = (text) => typeof text === 'string' && text.trimStart().startsWith(BEGIN);

  function parse(text) {
    const lines = String(text).replace(/\r/g, '').trim().split('\n').map((l) => l.trim());
    if (lines[0] !== BEGIN || lines[lines.length - 1] !== END) throw new Error('This is not a valid encrypted note');
    const head = {}; let i = 1;
    for (; i < lines.length - 1 && lines[i]; i++) { const m = /^([A-Za-z-]+):\s*(.+)$/.exec(lines[i]); if (!m) throw new Error('This is not a valid encrypted note'); head[m[1].toLowerCase()] = m[2].trim(); }
    const body = lines.slice(i + 1, -1).join('');
    if (head.version !== '1' || head.kdf !== 'PBKDF2-SHA256' || head.cipher !== 'AES-256-GCM') throw new Error('This note uses an encryption format this version does not understand');
    const iter = Number(head.iterations);
    if (!Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER) throw new Error('This note asks for an unreasonable amount of work to open; refusing');   // a crafted file must not be able to freeze the app
    let salt, iv, data;
    try { salt = unb64(head.salt || ''); iv = unb64(head.iv || ''); data = unb64(body); } catch { throw new Error('This is not a valid encrypted note'); }
    if (salt.length !== 16 || iv.length !== 12 || data.length < 16) throw new Error('This is not a valid encrypted note');
    return { iter, salt, iv, data };
  }
  const normalize = (pass) => String(pass).normalize('NFKC');
  async function deriveKey(pass, salt, iter) {
    const base = await subtle().importKey('raw', new TextEncoder().encode(normalize(pass)), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const checkPass = (pass) => { if (typeof pass !== 'string' || [...pass].length < MIN_PASS) throw new Error(`Use at least ${MIN_PASS} characters`); };

  // A session is what stays in memory while a note is unlocked: the derived key and the parameters it was made with (never the passphrase).
  async function newSession(pass) { checkPass(pass); const salt = rand(16); return { salt, iter: ITER, key: await deriveKey(pass, salt, ITER) }; }
  async function encrypt(plaintext, session) {
    const iv = rand(12), ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, session.key, new TextEncoder().encode(plaintext)));
    const body = b64(ct).replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
    return `${BEGIN}\nVersion: 1\nKDF: PBKDF2-SHA256\nIterations: ${session.iter}\nCipher: AES-256-GCM\nSalt: ${b64(session.salt)}\nIV: ${b64(iv)}\n\n${body}\n${END}\n`;
  }
  // -> { text, session }: the session can be kept to save further edits without asking for the passphrase again
  async function decrypt(envelope, passOrSession) {
    const p = parse(envelope);
    const session = typeof passOrSession === 'string' ? { salt: p.salt, iter: p.iter, key: await deriveKey(passOrSession, p.salt, p.iter) } : passOrSession;
    try {
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: p.iv, additionalData: AAD }, session.key, p.data);
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(pt), session: { salt: p.salt, iter: p.iter, key: session.key } };
    } catch { throw new Error('Wrong passphrase, or the note was changed'); }
  }
  async function encryptWithPassphrase(plaintext, pass) { const session = await newSession(pass); return { envelope: await encrypt(plaintext, session), session }; }

  // Web Crypto only exists on secure origins (https, or localhost); over plain http on a LAN there is nothing to encrypt with.
  const available = () => !!(root.crypto && root.crypto.subtle) || typeof require === 'function';
  const api = { available, isEnvelope, parse, newSession, encrypt, decrypt, encryptWithPassphrase, deriveKey, ITER, MIN_PASS, BEGIN, END };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PNCrypto = api;
})(typeof window !== 'undefined' ? window : globalThis);
