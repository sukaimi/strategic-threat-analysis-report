'use strict';

const { Router } = require('express');
const fs = require('fs');
const path = require('path');

const router = Router();

const OVERLAYS_DIR = path.resolve(__dirname, '../../data/overlays');

// Valid overlay types (matches JSON filenames without extension)
const VALID_TYPES = ['ports', 'anchorages', 'airbases', 'friendly_forces'];

// GET /api/overlays/:type — serve overlay JSON by type
router.get('/:type', (req, res, next) => {
  try {
    const { type } = req.params;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Invalid overlay type "${type}". Valid types: ${VALID_TYPES.join(', ')}`,
      });
    }

    const filePath = path.join(OVERLAYS_DIR, `${type}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Overlay data for "${type}" not found` });
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/overlays — list available overlay types
router.get('/', (_req, res) => {
  res.json({ types: VALID_TYPES });
});

module.exports = router;
