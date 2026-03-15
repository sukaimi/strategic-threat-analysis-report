'use strict';

const { Router } = require('express');
const {
  findCrossTheaterVessels,
  getUnifiedBriefing,
} = require('../services/crossTheater');

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/cross-theater/vessels — vessels seen in multiple theaters
// ---------------------------------------------------------------------------

router.get('/vessels', (_req, res, next) => {
  try {
    const vessels = findCrossTheaterVessels();
    res.json({
      generated: new Date().toISOString(),
      count: vessels.length,
      vessels,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cross-theater/briefing — unified STAR command briefing
// ---------------------------------------------------------------------------

router.get('/briefing', (_req, res, next) => {
  try {
    const briefing = getUnifiedBriefing();
    res.json(briefing);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
