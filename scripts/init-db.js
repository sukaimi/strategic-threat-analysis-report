'use strict';

const { getDb, close } = require('../api/src/db');

console.log('[init-db] Initialising database...');

try {
  const db = getDb();
  console.log('[init-db] Database initialised successfully at:', db.name);
} catch (err) {
  console.error('[init-db] Failed to initialise database:', err.message);
  process.exit(1);
} finally {
  close();
}

process.exit(0);
