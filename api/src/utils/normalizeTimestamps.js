'use strict';

const SQLITE_DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamps(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'string' && SQLITE_DT.test(out[key])) {
      out[key] = out[key].replace(' ', 'T') + 'Z';
    }
  }
  return out;
}

function normalizeTimestampsArray(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(normalizeTimestamps);
}

module.exports = { normalizeTimestamps, normalizeTimestampsArray };
