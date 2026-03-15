'use strict';

const { purge72h, close } = require('../api/src/db');

console.log('[purge-db] Purging records older than 72 hours...');

try {
  const result = purge72h();

  for (const [table, count] of Object.entries(result)) {
    console.log(`[purge-db] ${table}: ${count} rows deleted`);
  }

  console.log('[purge-db] Purge complete.');
} catch (err) {
  console.error('[purge-db] Purge failed:', err.message);
  process.exit(1);
} finally {
  close();
}

process.exit(0);
