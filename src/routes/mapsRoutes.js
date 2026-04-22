const express = require('express');
const requireDriverAuth = require('../middleware/requireDriverAuth');
const { getDirections } = require('../controllers/mapsController');

const router = express.Router();

// GET /api/maps/directions?originLat=..&originLng=..&destLat=..&destLng=..
router.get('/directions', requireDriverAuth, getDirections);

module.exports = router;
