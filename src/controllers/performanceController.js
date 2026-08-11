// performanceController.js
//
// Serves the dashboard's Performance page. Both routes are admin-only and
// answer for one store: req.storeId comes from the dispatcher's token, never
// from the query string, so a dispatcher cannot read another store's takings
// by editing the URL.

const {
  getDriverPerformance,
  getDriverPerformanceOrders,
  reportTimezone,
} = require("../services/performanceService");

// Dates arrive as plain YYYY-MM-DD and are read as calendar days in the store's
// timezone, not as instants. Anything else is rejected rather than coerced: a
// half-understood date would quietly report the wrong day's money.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Today where the store is, which is not necessarily today where the server is.
function todayInReportTimezone() {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape the queries expect.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: reportTimezone(),
  }).format(new Date());
}

// Reads ?from= and ?to=, defaulting to today, and returns null when either is
// unusable so the caller can answer 400 instead of guessing.
function parseRange(query) {
  const today = todayInReportTimezone();
  const from = (query.from || today).trim();
  const to = (query.to || from).trim();

  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) return null;
  // A backwards range returns nothing at all, which reads as "no deliveries"
  // rather than as the mistake it is.
  if (from > to) return null;

  return { from, to };
}

// GET /api/drivers/performance?from=YYYY-MM-DD&to=YYYY-MM-DD
// Every driver's figures for the period, plus the store-wide roll-up.
async function getPerformance(req, res) {
  const range = parseRange(req.query || {});
  if (!range) {
    return res.status(400).json({
      error: "from and to must be dates in YYYY-MM-DD format, with from on or before to",
    });
  }

  try {
    const report = await getDriverPerformance(req.storeId, range);
    return res.json(report);
  } catch (error) {
    console.error("Error building driver performance report:", error);
    return res.status(500).json({ error: "Failed to build performance report" });
  }
}

// GET /api/drivers/:id/performance?from=&to=
// The same period for one driver, with the orders behind the numbers so a
// figure that looks wrong can be checked against the actual deliveries.
async function getPerformanceForDriver(req, res) {
  const driverId = Number(req.params.id);
  if (!Number.isInteger(driverId) || driverId <= 0) {
    return res.status(400).json({ error: "Invalid driver ID" });
  }

  const range = parseRange(req.query || {});
  if (!range) {
    return res.status(400).json({
      error: "from and to must be dates in YYYY-MM-DD format, with from on or before to",
    });
  }

  try {
    const [report, orders] = await Promise.all([
      getDriverPerformance(req.storeId, range),
      getDriverPerformanceOrders(req.storeId, driverId, range),
    ]);

    const driver = report.drivers.find((row) => row.id === driverId);
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    return res.json({
      from: report.from,
      to: report.to,
      timezone: report.timezone,
      fee_per_delivery: report.fee_per_delivery,
      driver,
      orders,
    });
  } catch (error) {
    console.error("Error building driver performance detail:", error);
    return res.status(500).json({ error: "Failed to build performance report" });
  }
}

module.exports = {
  getPerformance,
  getPerformanceForDriver,
};
