'use strict';

const { Router } = require('express');

const router = Router();

// Lazy-load the NEA collector (may not be available)
let neaCollector = null;
try {
  neaCollector = require('../collectors/nea');
} catch (_) {
  /* not available */
}

// GET /api/nea/weather — returns latest cached NEA weather station data
router.get('/weather', (_req, res) => {
  if (!neaCollector) {
    return res.status(503).json({ error: 'NEA collector not available' });
  }

  const data = neaCollector.getLatestData();
  if (!data) {
    return res.json({
      rainfall: [],
      wind: [],
      temperature: [],
      forecast: [],
      fetchedAt: null,
    });
  }

  res.json(data);
});

module.exports = router;
