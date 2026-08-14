// statsRoutes.js
//
// Routes under /api/stats — the dashboard's Statistics page.
//
//   GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD
//     Every figure the page draws, for one store and one period.
//
// Admin JWT required; the middleware is applied where this router is mounted
// in app.js, so there is no unauthenticated path to a store's takings.

const express = require("express");
const router = express.Router();

const { getStats } = require("../controllers/statisticsController");

router.get("/", getStats);

module.exports = router;
