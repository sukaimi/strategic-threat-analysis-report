'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config');

const apiKeyAuth = require('./middleware/apiKey');
const rateLimit = require('./middleware/rateLimit');
const theaterMiddleware = require('./middleware/theater');

const healthRouter = require('./routes/health');
const vesselsRouter = require('./routes/vessels');
const flightsRouter = require('./routes/flights');
const weatherRouter = require('./routes/weather');
const portRouter = require('./routes/port');
const analysesRouter = require('./routes/analyses');
const alertsRouter = require('./routes/alerts');
const sanctionsRouter = require('./routes/sanctions');
const reportsRouter = require('./routes/reports');
const exportRouter = require('./routes/export');
const authRouter = require('./routes/auth');
const intelRouter = require('./routes/intel');
const overlaysRouter = require('./routes/overlays');
const neaRouter = require('./routes/nea');
const crossTheaterRouter = require('./routes/crossTheater');
const thermalRouter = require('./routes/thermal');

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// CORS
const corsOrigin = config.NODE_ENV === 'development' ? '*' : config.DOMAIN;
app.use(cors({ origin: corsOrigin }));

// JSON body parser
app.use(express.json());

// Security headers
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health endpoint — open (no auth, no rate limit)
app.use('/api/health', healthRouter);

// Auth routes — login/logout are open
app.use('/api/auth', authRouter);

// Auth & rate limiting for all other routes
app.use(apiKeyAuth);
app.use(rateLimit());

// Theater-aware DB selection (reads ?theater= query param)
app.use(theaterMiddleware);

// Theater config endpoint — returns theater definitions for the frontend
app.get('/api/theaters', (_req, res) => {
  const theaters = require('./theaters');
  res.json(theaters);
});

app.use('/api/vessels', vesselsRouter);
app.use('/api/flights', flightsRouter);
app.use('/api/weather', weatherRouter);
app.use('/api/port', portRouter);
app.use('/api/analyses', analysesRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/sanctions', sanctionsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/export', exportRouter);
app.use('/api/intel', intelRouter);
app.use('/api/overlays', overlaysRouter);
app.use('/api/nea', neaRouter);
app.use('/api/cross-theater', crossTheaterRouter);
app.use('/api/thermal', thermalRouter);

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error',
  });
});

module.exports = app;
