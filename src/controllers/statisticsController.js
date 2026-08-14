// statisticsController.js
//
// Serves the dashboard's Statistics page. Admin-only and answers for one store:
// req.storeId comes from the dispatcher's token, never from the query string,
// so a dispatcher cannot read another store's figures by editing the URL.

const { getStatistics, daysInRange } = require("../services/statisticsService");
const { reportTimezone } = require("../services/performanceService");

// Dates arrive as plain YYYY-MM-DD and are read as calendar days in the store's
// timezone, not as instants. Anything else is rejected rather than coerced.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A ceiling on the window, because the page draws one point per day and the
// queries scan the store's whole order history to build them. Two years is
// further back than anybody reads a delivery report, and asking for ten would
// return a chart with a thousand unreadable columns at the cost of a table scan
// on every request.
const MAX_RANGE_DAYS = 731;

function todayInReportTimezone() {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape the queries expect.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: reportTimezone(),
  }).format(new Date());
}

// Reads ?from= and ?to=, defaulting to today, and returns null when either is
// unusable so the caller can answer 400 instead of guessing.
//
// ?days=30 is the other way in: the last N days ending on the store's own
// today, inclusive of it. The page opens that way because a browser cannot work
// out which day "today" is where the store is standing until a response has
// told it the timezone — and asking for the wrong day's report first, only to
// correct it, would draw the page twice.
function parseRange(query) {
  const today = todayInReportTimezone();

  if (query.days !== undefined && !query.from && !query.to) {
    const days = Number(query.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_RANGE_DAYS) return null;
    const [year, month, day] = today.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - 1, day - (days - 1)));
    return { from: start.toISOString().slice(0, 10), to: today };
  }

  const from = (query.from || today).trim();
  const to = (query.to || from).trim();

  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) return null;
  // A backwards range returns nothing at all, which reads as "no deliveries"
  // rather than as the mistake it is.
  if (from > to) return null;

  return { from, to };
}

// GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD
async function getStats(req, res) {
  const range = parseRange(req.query || {});
  if (!range) {
    return res.status(400).json({
      error:
        "from and to must be dates in YYYY-MM-DD format, with from on or before to, " +
        `or days must be a whole number between 1 and ${MAX_RANGE_DAYS}`,
    });
  }

  if (daysInRange(range.from, range.to) > MAX_RANGE_DAYS) {
    return res.status(400).json({
      error: `The period cannot be longer than ${MAX_RANGE_DAYS} days`,
    });
  }

  try {
    const report = await getStatistics(req.storeId, range);
    return res.json(report);
  } catch (error) {
    console.error("Error building statistics report:", error);
    return res.status(500).json({ error: "Failed to build statistics report" });
  }
}

module.exports = { getStats };
