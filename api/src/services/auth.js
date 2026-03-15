'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours
const BCRYPT_ROUNDS = 10;

/**
 * Create a new user.
 * @param {string} username
 * @param {string} password  — plaintext, will be hashed
 * @param {string} role      — operator | analyst | commander | admin
 * @returns {{ id: number, username: string, role: string }}
 */
function createUser(username, password, role) {
  const db = getDb();
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(username, hash, role);
  return { id: info.lastInsertRowid, username, role };
}

/**
 * Authenticate a user and create a session.
 * @param {string} username
 * @param {string} password
 * @returns {{ token: string, user: { id: number, username: string, role: string } } | null}
 */
function login(username, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;

  if (!bcrypt.compareSync(password, user.password_hash)) return null;

  // Create session token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  db.prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).run(user.id, token, expiresAt);

  // Update last_login
  db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id);

  return {
    token,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

/**
 * Validate a session token.
 * @param {string} token
 * @returns {{ id: number, username: string, role: string } | null}
 */
function validateSession(token) {
  if (!token) return null;
  const db = getDb();

  const row = db.prepare(`
    SELECT u.id, u.username, u.role, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!row) return null;

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    // Clean up expired session
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return { id: row.id, username: row.username, role: row.role };
}

/**
 * Destroy a session.
 * @param {string} token
 */
function logout(token) {
  if (!token) return;
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * List all users (for admin).
 * @returns {Array<{ id: number, username: string, role: string, created_at: string, last_login: string|null }>}
 */
function listUsers() {
  const db = getDb();
  return db.prepare('SELECT id, username, role, created_at, last_login FROM users ORDER BY id').all();
}

/**
 * Delete a user and their sessions.
 * @param {number} userId
 * @returns {boolean}
 */
function deleteUser(userId) {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return info.changes > 0;
}

module.exports = { createUser, login, validateSession, logout, listUsers, deleteUser };
