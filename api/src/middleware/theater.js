'use strict';

const { getDb } = require('../db');
const theaters = require('../theaters');

/**
 * Express middleware that reads `req.query.theater` and attaches `req.theaterDb`
 * (the correct SQLite DB for that theater) and `req.theaterKey` to the request.
 *
 * If the theater param is missing or invalid, defaults to 'merlion'.
 */
function theaterMiddleware(req, _res, next) {
  const key = (req.query.theater || 'merlion').toLowerCase();
  req.theaterKey = theaters[key] ? key : 'merlion';
  req.theaterDb = getDb(req.theaterKey);
  next();
}

module.exports = theaterMiddleware;
