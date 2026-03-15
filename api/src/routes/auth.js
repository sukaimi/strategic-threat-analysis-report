'use strict';

const { Router } = require('express');
const { login, logout, validateSession, createUser, listUsers, deleteUser } = require('../services/auth');
const { requireAuth, requireRole } = require('../middleware/rbac');

const router = Router();

// POST /api/auth/login — authenticate and create session
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const result = login(username, password);

  if (!result) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Set httpOnly cookie
  const maxAge = 8 * 60 * 60 * 1000; // 8 hours
  res.cookie('singa-session', result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    path: '/',
  });

  res.json({ token: result.token, user: result.user });
});

// POST /api/auth/logout — destroy session
router.post('/logout', (req, res) => {
  // Extract token from cookie or header
  let token = null;
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('singa-session='));
    if (match) token = match.split('=')[1];
  }

  if (token) {
    logout(token);
  }

  res.clearCookie('singa-session', { path: '/' });
  res.json({ ok: true });
});

// GET /api/auth/me — current user info
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Admin: user management
// ---------------------------------------------------------------------------

// GET /api/auth/users — list all users (admin only)
router.get('/users', requireAuth, requireRole('admin'), (_req, res) => {
  res.json(listUsers());
});

// POST /api/auth/users — create a user (admin only)
router.post('/users', requireAuth, requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password, and role are required' });
  }

  const validRoles = ['operator', 'analyst', 'commander', 'admin'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
  }

  try {
    const user = createUser(username, password, role);
    res.status(201).json(user);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

// DELETE /api/auth/users/:id — delete a user (admin only)
router.delete('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const userId = parseInt(req.params.id, 10);

  // Prevent self-deletion
  if (req.user.id === userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const deleted = deleteUser(userId);
  if (!deleted) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ ok: true });
});

module.exports = router;
