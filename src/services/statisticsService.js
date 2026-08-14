// statisticsService.js
//
// The numbers behind the dashboard's Statistics page: how the store's delivery
// operation performed over a period, cut every way a dispatcher or an owner
// asks about it — over time, by hour of day, by weekday, by how long the trips
// took, by area, by city, by driver, and by how the money arrived.
//
// This file answers "how are we doing"; performanceService answers "what do I
// hand this driver tonight". They share their definitions rather than restating
// them — KIND_EXPR, FINISHED_AT, localExpr, the fee and the timezone are all
// imported from there — so a delivery counted on one page is the same delivery
// counted on the other. That matters more here than anywhere else: this page
// exists to be compared against the Performance page, and two files quietly
// disagreeing about what a delivery is would make both of them useless.
//
// Two clocks run through everything below, and every figure is labelled with
// which one it uses, because they answer different questions:
//
//   • Placed  — dated by created_at, the day Shopify took the order. This is
//     demand: how much work arrived.
//   • Finished — dated by delivered_at / returned_at, the day the driver was
//     done with it. This is throughput: how much work was completed, and it is
//     the clock the money runs on, since that is when the cash changed hands.
//
// An order placed on Monday and delivered on Wednesday is one order on
// Monday's demand and one delivery on Wednesday's throughput. Mixing the two
// would produce a chart that is wrong in a way nobody could spot.
//
// Every figure is scoped to one store and read against the store's own
// calendar — see localExpr in performanceService for why that needs saying.

const pool = require("../config/db");
const {
  KIND_EXPR,
  FINISHED_AT,
  localExpr,
  feePerDelivery,
  reportTimezone,
  round2,
  getDriverPerformance,
} = require("./performanceService");

// How long a trip is allowed to have taken before it is treated as a stamp
// nobody closed rather than as a delivery. An order started on Monday and
// marked delivered on Thursday is almost always a driver who forgot to tap the
// button, and a single one of those drags the average past anything useful.
const MAX_TRIP_MINUTES = 24 * 60;

// The buckets the delivery-time histogram is drawn in, in minutes. Fine at the
// short end because that is where the distribution actually lives, and open at
// the top because the tail is long and nobody needs it resolved.
const DURATION_BUCKETS = [
  { label: "< 15m", min: 0, max: 15 },
  { label: "15–30m", min: 15, max: 30 },
  { label: "30–45m", min: 30, max: 45 },
  { label: "45m–1h", min: 45, max: 60 },
  { label: "1–1.5h", min: 60, max: 90 },
  { label: "1.5–2h", min: 90, max: 120 },
  { label: "2–3h", min: 120, max: 180 },
  { label: "3h+", min: 180, max: null },
];

// Everything the queries below select from, in one place: the columns the page
// needs, plus the four derived values every block is built out of — what the
// order counts as, when it was finished, when it was placed, and how long the
// trip took. Parameters are always $1 store, $2 timezone.
const SCOPED_CTE = `
  scoped AS (
    SELECT
      o.id,
      o.assigned_driver_id,
      o.prepaid,
      COALESCE(o.total_price, 0)           AS total_price,
      o.order_status,
      o.area,
      o.city,
      o.delivery_started_at,
      ${KIND_EXPR}                          AS kind,
      ${localExpr(FINISHED_AT, "$2")}       AS finished_local,
      ${localExpr("o.created_at", "$2")}    AS created_local,
      ${localExpr("o.delivered_at", "$2")}  AS delivered_local,
      -- The trip, start to finish. Same rule as the Performance page's average:
      -- measured from when the driver set off, never from when Shopify took the
      -- order, and left NULL when the trip was not timed at all.
      (CASE
         WHEN o.delivered_at IS NOT NULL
              AND o.delivery_started_at IS NOT NULL
              AND o.delivered_at >= o.delivery_started_at
              AND o.delivered_at <= o.delivery_started_at + INTERVAL '${MAX_TRIP_MINUTES} minutes'
         THEN EXTRACT(EPOCH FROM (o.delivered_at - o.delivery_started_at)) / 60.0
       END)                                 AS trip_minutes
    FROM orders o
    WHERE o.store_id = $1
  )
`;

// The two windows, as SQL predicates over the CTE above. $3 is the first day of
// the period and $4 the last, both inclusive, both read as calendar days where
// the store is standing.
const FINISHED_IN_PERIOD = `(kind IS NOT NULL
  AND finished_local >= $3::date
  AND finished_local <  ($4::date + INTERVAL '1 day'))`;

const PLACED_IN_PERIOD = `(created_local >= $3::date
  AND created_local <  ($4::date + INTERVAL '1 day'))`;

/* ===========================
   DATES
=========================== */

// Calendar arithmetic on plain YYYY-MM-DD strings, shifted through UTC so that
// adding a day never depends on the server's own daylight-saving rules.
function shiftDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function utcDay(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

// Inclusive of both ends: a report for one day is one day long, not zero.
function daysInRange(from, to) {
  return Math.round((utcDay(to) - utcDay(from)) / 86400000) + 1;
}

// The window immediately before the one being read, of the same length. Every
// figure on the page is shown against it: a number on its own says nothing, and
// "142 deliveries" only becomes information next to last week's 118.
function previousRange({ from, to }) {
  const length = daysInRange(from, to);
  const prevTo = shiftDays(from, -1);
  return { from: shiftDays(prevTo, -(length - 1)), to: prevTo };
}

/* ===========================
   THE PERIOD'S HEADLINE FIGURES
=========================== */

// One row, and the source of every KPI tile on the page. Both clocks are read
// in the same pass so the demand figures and the throughput figures cannot come
// from two different snapshots of a table that is being written to constantly.
async function summaryRow(storeId, tz, { from, to }) {
  const result = await pool.query(
    `
    WITH ${SCOPED_CTE}
    SELECT
      -- Demand: orders placed in the period, and what became of them. This is a
      -- cohort — the same orders followed to their outcome — which is why it can
      -- be added up as a funnel and the throughput block below cannot.
      COUNT(*) FILTER (WHERE ${PLACED_IN_PERIOD})::int                    AS placed,
      COALESCE(SUM(total_price) FILTER (WHERE ${PLACED_IN_PERIOD}), 0)::float8
                                                                          AS placed_value,
      COUNT(*) FILTER (WHERE ${PLACED_IN_PERIOD} AND assigned_driver_id IS NOT NULL)::int
                                                                          AS placed_assigned,
      COUNT(*) FILTER (WHERE ${PLACED_IN_PERIOD} AND delivery_started_at IS NOT NULL)::int
                                                                          AS placed_started,
      COUNT(*) FILTER (WHERE ${PLACED_IN_PERIOD} AND kind = 'DELIVERED')::int
                                                                          AS placed_delivered,
      COUNT(*) FILTER (WHERE ${PLACED_IN_PERIOD} AND kind = 'RETURNED')::int
                                                                          AS placed_returned,
      COUNT(*) FILTER (WHERE ${PLACED_IN_PERIOD} AND order_status = 'CANCELLED')::int
                                                                          AS placed_cancelled,
      COUNT(*) FILTER (WHERE ${PLACED_IN_PERIOD}
                         AND kind IS NULL
                         AND order_status <> 'CANCELLED')::int            AS placed_open,

      -- Throughput: work finished in the period, whenever it was placed.
      COUNT(*) FILTER (WHERE ${FINISHED_IN_PERIOD} AND kind = 'DELIVERED')::int
                                                                          AS delivered,
      COUNT(*) FILTER (WHERE ${FINISHED_IN_PERIOD} AND kind = 'RETURNED')::int
                                                                          AS returned,
      COUNT(*) FILTER (WHERE ${FINISHED_IN_PERIOD} AND kind = 'DELIVERED' AND prepaid)::int
                                                                          AS prepaid_deliveries,
      -- Money. Cash is only what was taken at the door; a prepaid order was paid
      -- online and brought back nothing, so counting its total as cash would
      -- invent money that is not in the bag. Revenue is the two together: what
      -- the store earned by delivering, however it was paid.
      COALESCE(SUM(total_price) FILTER (WHERE ${FINISHED_IN_PERIOD}
                                          AND kind = 'DELIVERED'
                                          AND NOT prepaid), 0)::float8    AS cash_collected,
      COALESCE(SUM(total_price) FILTER (WHERE ${FINISHED_IN_PERIOD}
                                          AND kind = 'DELIVERED'
                                          AND prepaid), 0)::float8        AS prepaid_value,
      COALESCE(SUM(total_price) FILTER (WHERE ${FINISHED_IN_PERIOD}
                                          AND kind = 'DELIVERED'), 0)::float8
                                                                          AS revenue,
      COALESCE(SUM(total_price) FILTER (WHERE ${FINISHED_IN_PERIOD}
                                          AND kind = 'RETURNED'), 0)::float8
                                                                          AS returned_value,
      COUNT(DISTINCT assigned_driver_id) FILTER (WHERE ${FINISHED_IN_PERIOD})::int
                                                                          AS drivers_active,
      -- Trip length, averaged and — more usefully — at the middle and the slow
      -- end. The average alone hides the shape: a median of 28 minutes with a
      -- 90th percentile of two hours is a very different operation from one
      -- where both sit at 40.
      (AVG(trip_minutes) FILTER (WHERE ${FINISHED_IN_PERIOD}
                                   AND kind = 'DELIVERED'))::float8       AS avg_minutes,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY trip_minutes)
        FILTER (WHERE ${FINISHED_IN_PERIOD}
                  AND kind = 'DELIVERED'
                  AND trip_minutes IS NOT NULL))::float8                  AS median_minutes,
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY trip_minutes)
        FILTER (WHERE ${FINISHED_IN_PERIOD}
                  AND kind = 'DELIVERED'
                  AND trip_minutes IS NOT NULL))::float8                  AS p90_minutes,
      COUNT(*) FILTER (WHERE ${FINISHED_IN_PERIOD}
                         AND kind = 'DELIVERED'
                         AND trip_minutes IS NOT NULL)::int               AS timed_deliveries
    FROM scoped
    `,
    [storeId, tz, from, to]
  );

  return result.rows[0];
}

// The tiles, derived from one summary row. Rates are computed here rather than
// in SQL so the zero cases are answered once: a period with no work has no
// success rate, and reporting 0% for it would read as a catastrophe rather than
// as a quiet day.
function summaryOf(row, fee) {
  const finished = row.delivered + row.returned;
  const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
  const minutes = (value) => (value === null || value === undefined ? null : Math.round(value));

  return {
    placed: row.placed,
    placed_value: round2(row.placed_value),
    delivered: row.delivered,
    returned: row.returned,
    finished,
    revenue: round2(row.revenue),
    cash_collected: round2(row.cash_collected),
    prepaid_value: round2(row.prepaid_value),
    prepaid_deliveries: row.prepaid_deliveries,
    returned_value: round2(row.returned_value),
    drivers_active: row.drivers_active,
    // What the store owes its drivers for the period, at the same flat fee the
    // Performance page settles on.
    driver_pay: round2(row.delivered * fee),
    // Per delivery rather than per order placed: this is what a completed
    // delivery is worth, which is the figure an owner compares between periods.
    avg_order_value: row.delivered > 0 ? round2(row.revenue / row.delivered) : null,
    // Of the work that ended in the period, how much of it ended well.
    success_rate: rate(row.delivered, finished),
    return_rate: rate(row.returned, finished),
    // How much of the money arrived before the driver ever set off.
    prepaid_share: rate(row.prepaid_deliveries, row.delivered),
    avg_minutes: minutes(row.avg_minutes),
    median_minutes: minutes(row.median_minutes),
    p90_minutes: minutes(row.p90_minutes),
    timed_deliveries: row.timed_deliveries,
    // Deliveries per driver who actually worked — the fleet's productivity,
    // which a raw delivery count cannot show because it moves when the roster
    // does.
    deliveries_per_driver:
      row.drivers_active > 0
        ? Math.round((row.delivered / row.drivers_active) * 10) / 10
        : null,
  };
}

// The cohort of orders placed in the period, followed to where each one ended
// up. Drawn as a funnel, so the stages have to be nested rather than merely
// adjacent: every delivered order was started, every started one was assigned.
function funnelOf(row) {
  return {
    placed: row.placed,
    assigned: row.placed_assigned,
    started: row.placed_started,
    delivered: row.placed_delivered,
    returned: row.placed_returned,
    cancelled: row.placed_cancelled,
    open: row.placed_open,
  };
}

/* ===========================
   THE SERIES
=========================== */

// One row per calendar day in the range, including the days nothing happened —
// generate_series rather than the rows that exist, because a line chart that
// silently skips an empty Sunday draws a week as if it were six days long.
async function dailySeries(storeId, tz, { from, to }) {
  const result = await pool.query(
    `
    WITH ${SCOPED_CTE},
    days AS (
      SELECT generate_series($3::date, $4::date, INTERVAL '1 day')::date AS day
    ),
    placed AS (
      SELECT
        created_local::date                 AS day,
        COUNT(*)::int                       AS placed,
        COALESCE(SUM(total_price), 0)::float8 AS placed_value
      FROM scoped
      WHERE ${PLACED_IN_PERIOD}
      GROUP BY 1
    ),
    finished AS (
      SELECT
        finished_local::date                AS day,
        COUNT(*) FILTER (WHERE kind = 'DELIVERED')::int AS delivered,
        COUNT(*) FILTER (WHERE kind = 'RETURNED')::int  AS returned,
        COALESCE(SUM(total_price) FILTER (WHERE kind = 'DELIVERED'), 0)::float8
                                            AS revenue,
        COALESCE(SUM(total_price) FILTER (WHERE kind = 'DELIVERED' AND NOT prepaid), 0)::float8
                                            AS cash
      FROM scoped
      WHERE ${FINISHED_IN_PERIOD}
      GROUP BY 1
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD')          AS day,
      -- The weekday is worked out here because the browser cannot: these are
      -- calendar days in the store's timezone, and parsing "2026-08-14" in a
      -- browser some hours away can land on the day before.
      to_char(d.day, 'Dy')                  AS weekday,
      COALESCE(p.placed, 0)::int            AS placed,
      COALESCE(p.placed_value, 0)::float8   AS placed_value,
      COALESCE(f.delivered, 0)::int         AS delivered,
      COALESCE(f.returned, 0)::int          AS returned,
      COALESCE(f.revenue, 0)::float8        AS revenue,
      COALESCE(f.cash, 0)::float8           AS cash
    FROM days d
    LEFT JOIN placed p   ON p.day = d.day
    LEFT JOIN finished f ON f.day = d.day
    ORDER BY d.day
    `,
    [storeId, tz, from, to]
  );

  return result.rows.map((row) => ({
    ...row,
    placed_value: round2(row.placed_value),
    revenue: round2(row.revenue),
    cash: round2(row.cash),
  }));
}

// Deliveries by hour of the day, all 24 present whether or not anybody
// delivered in them — the empty hours are the point. This is the chart that
// says when the fleet is actually needed, which is the one thing a delivery
// count for the day cannot tell anyone.
async function hourlyHistogram(storeId, tz, range) {
  const result = await pool.query(
    `
    WITH ${SCOPED_CTE}
    SELECT
      EXTRACT(HOUR FROM delivered_local)::int AS hour,
      COUNT(*)::int                           AS delivered,
      COALESCE(SUM(total_price), 0)::float8   AS revenue
    FROM scoped
    WHERE ${FINISHED_IN_PERIOD} AND kind = 'DELIVERED'
    GROUP BY 1
    `,
    [storeId, tz, range.from, range.to]
  );

  const byHour = new Map(result.rows.map((row) => [row.hour, row]));
  return Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour);
    return {
      hour,
      // 24-hour clock: this is an operations chart, and "13:00" is unambiguous
      // in a way that "1 PM" squeezed under a column is not.
      label: `${String(hour).padStart(2, "0")}:00`,
      delivered: row ? row.delivered : 0,
      revenue: row ? round2(row.revenue) : 0,
    };
  });
}

// The same idea a week wide. Monday-first, matching the driver app's week and
// the Performance page's "this week", so all three windows line up.
async function weekdayHistogram(storeId, tz, range) {
  const result = await pool.query(
    `
    WITH ${SCOPED_CTE}
    SELECT
      EXTRACT(ISODOW FROM finished_local)::int AS weekday,
      COUNT(*) FILTER (WHERE kind = 'DELIVERED')::int AS delivered,
      COUNT(*) FILTER (WHERE kind = 'RETURNED')::int  AS returned,
      COALESCE(SUM(total_price) FILTER (WHERE kind = 'DELIVERED'), 0)::float8 AS revenue
    FROM scoped
    WHERE ${FINISHED_IN_PERIOD}
    GROUP BY 1
    `,
    [storeId, tz, range.from, range.to]
  );

  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const byDay = new Map(result.rows.map((row) => [row.weekday, row]));
  return names.map((label, index) => {
    const row = byDay.get(index + 1); // ISODOW: Monday = 1
    return {
      weekday: index + 1,
      label,
      delivered: row ? row.delivered : 0,
      returned: row ? row.returned : 0,
      revenue: row ? round2(row.revenue) : 0,
    };
  });
}

// How long the trips took, as a distribution rather than as an average. Only
// deliveries that were actually timed are in it — a trip nobody started on the
// record has no length, and guessing one from the order's creation would put a
// 30-minute run in the "3h+" bucket.
async function durationHistogram(storeId, tz, range) {
  const cases = DURATION_BUCKETS.map((bucket, index) =>
    bucket.max === null
      ? `WHEN trip_minutes >= ${bucket.min} THEN ${index}`
      : `WHEN trip_minutes < ${bucket.max} THEN ${index}`
  ).join("\n        ");

  const result = await pool.query(
    `
    WITH ${SCOPED_CTE},
    timed AS (
      SELECT
        CASE
        ${cases}
        END AS bucket
      FROM scoped
      WHERE ${FINISHED_IN_PERIOD}
        AND kind = 'DELIVERED'
        AND trip_minutes IS NOT NULL
    )
    SELECT bucket, COUNT(*)::int AS deliveries
    FROM timed
    GROUP BY bucket
    `,
    [storeId, tz, range.from, range.to]
  );

  const byBucket = new Map(result.rows.map((row) => [row.bucket, row.deliveries]));
  return DURATION_BUCKETS.map((bucket, index) => ({
    label: bucket.label,
    min: bucket.min,
    max: bucket.max,
    deliveries: byBucket.get(index) || 0,
  }));
}

/* ===========================
   WHERE THE WORK IS
=========================== */

// Deliveries and money by place. Two cuts of the same question because they
// answer different ones: the area (a caza) is how a dispatcher plans a route,
// the city is how they recognise an address.
//
// `column` is not user input — it is one of two literals chosen below — so
// interpolating it cannot carry anything into the query.
async function placeBreakdown(storeId, tz, range, column, limit) {
  const result = await pool.query(
    `
    WITH ${SCOPED_CTE}
    SELECT
      COALESCE(NULLIF(TRIM(${column}), ''), 'Unknown')  AS name,
      COUNT(*) FILTER (WHERE kind = 'DELIVERED')::int   AS delivered,
      COUNT(*) FILTER (WHERE kind = 'RETURNED')::int    AS returned,
      COALESCE(SUM(total_price) FILTER (WHERE kind = 'DELIVERED'), 0)::float8 AS revenue,
      COALESCE(SUM(total_price) FILTER (WHERE kind = 'DELIVERED' AND NOT prepaid), 0)::float8
                                                        AS cash,
      (AVG(trip_minutes) FILTER (WHERE kind = 'DELIVERED'))::float8 AS avg_minutes
    FROM scoped
    WHERE ${FINISHED_IN_PERIOD}
    GROUP BY 1
    ORDER BY delivered DESC, revenue DESC, name ASC
    LIMIT $5
    `,
    [storeId, tz, range.from, range.to, limit]
  );

  return result.rows.map((row) => ({
    ...row,
    revenue: round2(row.revenue),
    cash: round2(row.cash),
    avg_minutes: row.avg_minutes === null ? null : Math.round(row.avg_minutes),
  }));
}

/* ===========================
   RIGHT NOW
=========================== */

// The backlog as it stands this second, which no period can describe: orders
// nobody has been given, orders sitting with a driver, and the cash riding
// around in their bags. Deliberately not scoped to the range — "unassigned" is
// a fact about now, and dating it would make it disappear from every report
// that does not happen to include today.
async function liveBacklog(storeId) {
  const result = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE assigned_driver_id IS NULL)::int      AS unassigned,
      COUNT(*) FILTER (WHERE assigned_driver_id IS NOT NULL
                         AND delivery_started_at IS NULL)::int     AS assigned,
      COUNT(*) FILTER (WHERE delivery_started_at IS NOT NULL)::int AS on_the_road,
      COUNT(*)::int                                                AS open_orders,
      COALESCE(SUM(CASE WHEN prepaid THEN 0 ELSE COALESCE(total_price, 0) END), 0)::float8
                                                                   AS cash_on_the_road,
      COALESCE(SUM(COALESCE(total_price, 0)), 0)::float8           AS open_value
    FROM orders
    WHERE store_id = $1
      AND order_status NOT IN ('DELIVERED', 'FULFILLED', 'CANCELLED', 'RETURNED')
    `,
    [storeId]
  );

  const row = result.rows[0];
  return {
    ...row,
    cash_on_the_road: round2(row.cash_on_the_road),
    open_value: round2(row.open_value),
  };
}

/* ===========================
   THE REPORT
=========================== */

// Everything the Statistics page draws, for one store and one period, in one
// response. One round trip rather than nine: every block is a cut of the same
// window, and fetching them separately would let the page show a delivery count
// from one moment beside a revenue figure from another.
async function getStatistics(storeId, range) {
  const tz = reportTimezone();
  const fee = feePerDelivery();
  const previous = previousRange(range);

  const [
    current,
    prior,
    daily,
    hourly,
    weekday,
    durations,
    areas,
    cities,
    performance,
    live,
  ] = await Promise.all([
    summaryRow(storeId, tz, range),
    summaryRow(storeId, tz, previous),
    dailySeries(storeId, tz, range),
    hourlyHistogram(storeId, tz, range),
    weekdayHistogram(storeId, tz, range),
    durationHistogram(storeId, tz, range),
    placeBreakdown(storeId, tz, range, "area", 12),
    placeBreakdown(storeId, tz, range, "city", 10),
    // Borrowed whole rather than re-queried: the driver table on this page is
    // the Performance page's own figures, so a dispatcher cross-checking the
    // two cannot be shown two different answers for one driver.
    getDriverPerformance(storeId, range),
    liveBacklog(storeId),
  ]);

  const summary = summaryOf(current, fee);

  return {
    from: range.from,
    to: range.to,
    days: daysInRange(range.from, range.to),
    timezone: tz,
    fee_per_delivery: fee,
    generated_at: new Date().toISOString(),

    summary,
    // The same shape for the window before it, so the page can put every tile
    // against its own past without knowing how the comparison was built.
    previous: { from: previous.from, to: previous.to, ...summaryOf(prior, fee) },

    funnel: funnelOf(current),
    daily,
    hourly,
    weekday,
    durations,
    areas,
    cities,
    // Only the drivers who did something in the window: this is a ranking, and
    // a leaderboard padded with everyone who was idle ranks nothing.
    drivers: performance.drivers.filter(
      (driver) => driver.delivered > 0 || driver.returned > 0
    ),
    payment_mix: {
      cash_deliveries: summary.delivered - summary.prepaid_deliveries,
      cash_value: summary.cash_collected,
      prepaid_deliveries: summary.prepaid_deliveries,
      prepaid_value: summary.prepaid_value,
    },
    live,
  };
}

module.exports = {
  getStatistics,
  previousRange,
  daysInRange,
  DURATION_BUCKETS,
};
