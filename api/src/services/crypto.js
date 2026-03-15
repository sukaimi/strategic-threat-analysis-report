'use strict';

const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // GCM recommended IV length
const TAG_LENGTH = 16;  // Auth tag length

/**
 * Derive a 32-byte key from the configured ENCRYPTION_KEY.
 * Uses SHA-256 to normalise any-length passphrase to exactly 32 bytes.
 * @returns {Buffer}
 */
function deriveKey() {
  const raw = config.ENCRYPTION_KEY;
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * @param {string} plaintext
 * @param {string} [keyOverride] — optional key override (defaults to env ENCRYPTION_KEY)
 * @returns {{ iv: string, encrypted: string, tag: string }} — all base64
 */
function encrypt(plaintext, keyOverride) {
  const key = keyOverride
    ? crypto.createHash('sha256').update(keyOverride).digest()
    : deriveKey();

  if (!key) throw new Error('ENCRYPTION_KEY is not configured');

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    encrypted,
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt ciphertext produced by encrypt().
 * @param {{ iv: string, encrypted: string, tag: string }} payload — all base64
 * @param {string} [keyOverride]
 * @returns {string} plaintext
 */
function decrypt(payload, keyOverride) {
  const key = keyOverride
    ? crypto.createHash('sha256').update(keyOverride).digest()
    : deriveKey();

  if (!key) throw new Error('ENCRYPTION_KEY is not configured');

  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(payload.encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Create an HMAC-SHA256 signature.
 * @param {string} payload — data to sign
 * @param {string} secret  — signing secret
 * @returns {string} hex-encoded HMAC
 */
function hmacSign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

module.exports = { encrypt, decrypt, hmacSign };
