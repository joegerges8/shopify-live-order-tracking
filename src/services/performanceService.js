// performanceService.js
//
// The numbers behind the dashboard's Performance page: what each driver
// delivered, what cash they are carrying because of it, and what the store
// owes them for the day.
//
// Three rules decide every figure here, and they are the reason this file
// exists instead of the page adding up the order list itself:
//
//  1. A delivery counts once the driver marked it delivered — delivered_at is
//     stamped then and never moved. order_status is not enough on its own: a
//     dispatcher who later marks the order FULFILLED overwrites DELIVERED, and
//     the driver still did the work. So a completed delivery is
//     "delivered_at IS NOT NULL and the order did not end up cancelled".
//
//  2. Cash collected is only what the driver actually took at the door, so
//     prepaid orders contribute 0. They were paid online before the driver
//     ever saw them; counting their total as cash would invent money that is
//     not in the bag. The driver app draws the same line (OrderModel.earnedPrice)
//     and the two must not disagree.
//
//  3. Driver pay is a flat fee per completed delivery — the "$2 rule". It is
//     paid for making the trip, so a prepaid order earns the fee like any
//     other even though it brought in no cash. This mirrors driverPayFor() in
//     the driver app; DRIVER_FEE_PER_DELIVERY changes both only if it is
//     changed in both places.
//
// Everything is scoped to one store (orders belong to a store; drivers are
// shared across stores) and to a date range read in the store's own timezone —
// see localExpr below for why that needs saying out loud.

const pool = require("../config/db");

// What the store pays a driver for one completed delivery, in whole currency
// units. Overridable so a store on a different rate does not have to fork the
// code, but the default is the arrangement the driver app ships with.
const DEFAULT_FEE_PER_DELIVERY = 2;

function feePerDelivery() {
  const configured = Number(process.env.DRIVER_FEE_PER_DELIVERY);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_FEE_PER_DELIVERY;
}

// The timezone the day is counted in. "Today's deliveries" has to mean the
// dispatcher's today — a store in Beirut settling up at 9pm would otherwise
// see the evening's orders land on tomorrow's sheet, because the database
// clock is UTC. Falls back to the ETA service's timezone so a store that has
// already configured one does not have to configure it twice.
function reportTimezone() {
  return (
    process.env.REPORT_TIMEZONE ||
    process.env.ETA_TIMEZONE ||
    "Asia/Beirut"
  ).trim();
}

// Rewrites a naive timestamp column as wall-clock time in the report timezone.
//
// orders.delivered_at is TIMESTAMP WITHOUT TIME ZONE written by NOW(), so what
// is stored is the database session's local time — UTC in every deployment,
// but current_setting('TimeZone') asks rather than assumes. The first AT TIME
// ZONE reads the stored value back as a real instant, the second one expresses
// that instant where the store is standing.
function localExpr(column, tzParam) {
  return `((${column}) AT TIME ZONE current_setting('TimeZone') AT TIME ZONE ${tzParam})`;
}

// Which orders belong to the period, and what each one counts as.
//
// A delivered order is dated by delivered_at — the moment the money changed
// hands. A returned order has no timestamp of its own (there is no returned_at
// column), so it is dated by created_at: it came back the same run it went out,
// near enough for a day sheet, and it carries no cash either way.
const KIND_EXPR = `
  CASE
    WHEN o.delivered_at IS NOT NULL
         AND o.order_status NOT IN ('CANCELLED', 'RETURNED') THEN 'DELIVERED'
    WHEN o.order_status = 'RETURNED' THEN 'RETURNED'
  END`;

// Orders the driver is holding right now: assigned, not finished. Not part of
// the period totals — this is cash on the road, not cash in the drawer — but
// the dispatcher counting money at the end of the day needs to know it is
// still out there before deciding the driver's bag is short.
const ACTIVE_STATUSES = "('DELIVERED', 'FULFILLED', 'CANCELLED', 'RETURNED')";

// One row per driver for the requested period.
//
// Every driver in the system is returned, including those who did nothing in
// the window — the page decides who to show. Drivers are global, so a driver
// who has never worked for this store comes back with zeroes rather than being
// silently dropped, which is the honest answer to "who could I have used".
async function getDriverPerformance(storeId, { from, to }) {
  const tz = reportTimezone();
  const fee = feePerDelivery();

  // $1 store, $2 timezone, $3 from (inclusive), $4 to (inclusive).
  const finishedLocal = localExpr("COALESCE(o.delivered_at, o.created_at)", "$2");

  const result = await pool.query(
    `
    WITH scoped AS (
      SELECT
        o.assigned_driver_id                AS driver_id,
        o.prepaid,
        COALESCE(o.total_price, 0)          AS total_price,
        o.delivered_at,
        o.created_at,
        ${KIND_EXPR}                        AS kind,
        ${finishedLocal}                    AS finished_local,
        ${localExpr("o.delivered_at", "$2")} AS delivered_local
      FROM orders o
      WHERE o.store_id = $1
        AND o.assigned_driver_id IS NOT NULL
    ),
    period AS (
      SELECT *
      FROM scoped
      WHERE kind IS NOT NULL
        AND finished_local >= $3::date
        AND finished_local <  ($4::date + INTERVAL '1 day')
    ),
    active AS (
      SELECT
        o.assigned_driver_id AS driver_id,
        COUNT(*)             AS orders_out,
        COALESCE(SUM(CASE WHEN o.prepaid THEN 0 ELSE COALESCE(o.total_price, 0) END), 0)
                             AS cash_out
      FROM orders o
      WHERE o.store_id = $1
        AND o.assigned_driver_id IS NOT NULL
        AND o.order_status NOT IN ${ACTIVE_STATUSES}
      GROUP BY o.assigned_driver_id
    )
    SELECT
      d.id,
      d.full_name,
      d.phone,
      COUNT(p.driver_id) FILTER (WHERE p.kind = 'DELIVERED')::int          AS delivered,
      COUNT(p.driver_id) FILTER (WHERE p.kind = 'DELIVERED' AND p.prepaid)::int
                                                                          AS prepaid_deliveries,
      COUNT(p.driver_id) FILTER (WHERE p.kind = 'RETURNED')::int           AS returned,
      COALESCE(SUM(p.total_price) FILTER (WHERE p.kind = 'DELIVERED' AND NOT p.prepaid), 0)::float8
                                                                          AS cash_collected,
      COALESCE(SUM(p.total_price) FILTER (WHERE p.kind = 'DELIVERED' AND p.prepaid), 0)::float8
                                                                          AS prepaid_value,
      COALESCE(SUM(p.total_price) FILTER (WHERE p.kind = 'RETURNED'), 0)::float8
                                                                          AS returned_value,
      -- Formatted here rather than in the browser: these are naive timestamps,
      -- and handing one to JavaScript makes the displayed hour depend on the
      -- Node process's timezone as well as the database's. Postgres already
      -- knows both, so it answers with the wall-clock string the store reads.
      to_char(MIN(p.delivered_local) FILTER (WHERE p.kind = 'DELIVERED'), 'YYYY-MM-DD HH24:MI')
                                                                          AS first_delivery_at,
      to_char(MAX(p.delivered_local) FILTER (WHERE p.kind = 'DELIVERED'), 'YYYY-MM-DD HH24:MI')
                                                                          AS last_delivery_at,
      (AVG(EXTRACT(EPOCH FROM (p.delivered_at - p.created_at)) / 60.0)
        FILTER (WHERE p.kind = 'DELIVERED'))::float8                      AS avg_minutes_to_deliver,
      COALESCE(a.orders_out, 0)::int                                      AS orders_out,
      COALESCE(a.cash_out, 0)::float8                                     AS cash_out
    FROM drivers d
    LEFT JOIN period p ON p.driver_id = d.id
    LEFT JOIN active a ON a.driver_id = d.id
    GROUP BY d.id, d.full_name, d.phone, a.orders_out, a.cash_out
    ORDER BY delivered DESC, cash_collected DESC, d.full_name ASC
    `,
    [storeId, tz, from, to]
  );

  const drivers = result.rows.map((row) => withPay(row, fee));

  return {
    from,
    to,
    timezone: tz,
    fee_per_delivery: fee,
    drivers,
    totals: totalsOf(drivers, fee),
  };
}

// The two derived figures the dispatcher actually acts on.
//
// pay_owed is the $2 rule applied to the period's deliveries. cash_to_hand_in
// is what should physically come back across the table: the cash the driver
// collected, minus the pay they keep out of it. Paying the driver from the bag
// they are already holding is how this is settled in practice, so the number is
// computed that way rather than leaving the dispatcher to do the subtraction
// while counting notes.
function withPay(row, fee) {
  const cashCollected = round2(row.cash_collected);
  const payOwed = round2(row.delivered * fee);

  return {
    ...row,
    cash_collected: cashCollected,
    prepaid_value: round2(row.prepaid_value),
    returned_value: round2(row.returned_value),
    cash_out: round2(row.cash_out),
    avg_minutes_to_deliver:
      row.avg_minutes_to_deliver === null
        ? null
        : Math.round(row.avg_minutes_to_deliver),
    pay_owed: payOwed,
    cash_to_hand_in: round2(cashCollected - payOwed),
  };
}

// Store-wide roll-up. Summed from the per-driver rows rather than re-queried so
// the header can never disagree with the cards underneath it.
function totalsOf(drivers, fee) {
  const sum = (key) => round2(drivers.reduce((acc, d) => acc + d[key], 0));

  const delivered = drivers.reduce((acc, d) => acc + d.delivered, 0);
  const cashCollected = sum("cash_collected");
  const payOwed = round2(delivered * fee);

  return {
    drivers_worked: drivers.filter((d) => d.delivered > 0 || d.returned > 0).length,
    delivered,
    prepaid_deliveries: drivers.reduce((acc, d) => acc + d.prepaid_deliveries, 0),
    returned: drivers.reduce((acc, d) => acc + d.returned, 0),
    cash_collected: cashCollected,
    prepaid_value: sum("prepaid_value"),
    returned_value: sum("returned_value"),
    orders_out: drivers.reduce((acc, d) => acc + d.orders_out, 0),
    cash_out: sum("cash_out"),
    pay_owed: payOwed,
    cash_to_hand_in: round2(cashCollected - payOwed),
  };
}

// Money is added up here and shown to someone counting notes, so the floating
// point crumbs from summing NUMERIC columns have to go before they reach the
// page as $148.29999999999998.
function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// The orders behind one driver's numbers, so a figure that looks wrong can be
// traced to the order that caused it. Same period and same rules as the
// summary above — this is the receipt for that row, not a second opinion.
async function getDriverPerformanceOrders(storeId, driverId, { from, to }) {
  const tz = reportTimezone();
  const finishedLocal = localExpr("COALESCE(o.delivered_at, o.created_at)", "$3");

  const result = await pool.query(
    `
    SELECT
      o.id,
      o.order_number,
      o.customer_first_name,
      o.customer_last_name,
      o.customer_phone,
      o.city,
      o.area,
      COALESCE(o.total_price, 0)::float8 AS total_price,
      o.prepaid,
      o.order_status,
      -- Wall-clock strings in the store's timezone, for the same reason the
      -- summary formats its timestamps in SQL.
      to_char(${localExpr("o.created_at", "$3")}, 'YYYY-MM-DD HH24:MI')   AS created_local,
      to_char(${localExpr("o.delivered_at", "$3")}, 'YYYY-MM-DD HH24:MI') AS delivered_local,
      ${KIND_EXPR} AS kind
    FROM orders o
    WHERE o.store_id = $1
      AND o.assigned_driver_id = $2
      AND ${KIND_EXPR} IS NOT NULL
      AND ${finishedLocal} >= $4::date
      AND ${finishedLocal} <  ($5::date + INTERVAL '1 day')
    ORDER BY COALESCE(o.delivered_at, o.created_at) DESC
    LIMIT 500
    `,
    [storeId, driverId, tz, from, to]
  );

  return result.rows.map((row) => ({
    ...row,
    total_price: round2(row.total_price),
    // What this order put in the driver's pocket for the store: nothing when
    // the customer had already paid online.
    cash: row.prepaid || row.kind !== "DELIVERED" ? 0 : round2(row.total_price),
  }));
}

module.exports = {
  getDriverPerformance,
  getDriverPerformanceOrders,
  feePerDelivery,
  reportTimezone,
};
