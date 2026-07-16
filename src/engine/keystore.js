// Encrypted local keystore. The private key never leaves this machine and is
// only held in memory after you unlock it with your password.
//
// Uses Node's built-in crypto (scrypt + AES-256-GCM). No external deps, no network.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';

const KEYSTORE_DIR = path.join(os.homedir(), '.rh-sniper');
const KEYSTORE_PATH = path.join(KEYSTORE_DIR, 'keystore.json');

function normalizePk(pk) {
  const clean = pk.trim().toLowerCase();
  return clean.startsWith('0x') ? clean : '0x' + clean;
}

export function keystoreExists() {
  return fs.existsSync(KEYSTORE_PATH);
}

// Encrypt a private key under a password and write it to disk.
export function saveKey(privateKey, password) {
  const pk = normalizePk(privateKey);
  // sanity: this throws if the key is malformed
  const account = privateKeyToAccount(pk);

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const dk = crypto.scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', dk, iv);
  const ct = Buffer.concat([cipher.update(pk, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const blob = {
    version: 1,
    address: account.address,
    kdf: { name: 'scrypt', N: 2 ** 15, r: 8, p: 1, salt: salt.toString('hex') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('hex'),
    ciphertext: ct.toString('hex'),
    tag: tag.toString('hex')
  };

  fs.mkdirSync(KEYSTORE_DIR, { recursive: true });
  fs.writeFileSync(KEYSTORE_PATH, JSON.stringify(blob, null, 2), { mode: 0o600 });
  return account.address;
}

// Decrypt and return a viem account. Throws on wrong password.
export function unlock(password) {
  if (!keystoreExists()) throw new Error('No keystore found. Import a key first.');
  const blob = JSON.parse(fs.readFileSync(KEYSTORE_PATH, 'utf8'));
  const salt = Buffer.from(blob.kdf.salt, 'hex');
  const dk = crypto.scryptSync(password, salt, 32, { N: blob.kdf.N, r: blob.kdf.r, p: blob.kdf.p, maxmem: 128 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', dk, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  let pk;
  try {
    pk = Buffer.concat([
      decipher.update(Buffer.from(blob.ciphertext, 'hex')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new Error('Wrong password (or corrupted keystore).');
  }
  return privateKeyToAccount(pk);
}

export function savedAddress() {
  if (!keystoreExists()) return null;
  return JSON.parse(fs.readFileSync(KEYSTORE_PATH, 'utf8')).address;
}
