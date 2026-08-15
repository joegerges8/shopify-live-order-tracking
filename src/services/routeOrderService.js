// routeOrderService.js
//
// Puts a driver's assigned orders into the order they should be driven in, and
// writes that sequence to orders.route_sequence.
//
// The problem it solves: a driver's list arrived in the order the dispatcher
// happened to assign it, which is roughly when each order was placed. On a run
// of a dozen stops that means driving past Zalka to reach Dekwaneh and back up
// to Antelias. The area filter chips group the run by caza, but inside a caza
// the same shuffle remained.
//
// How the sequence is decided, best first:
//
//   1. GOOGLE   — the stops go to the Directions API with optimize:true, which
//                 solves the travelling-salesman problem over the real road
//                 network and returns the driving order. See
//                 mapsService.optimizeStopOrder.
//   2. DISTANCE — no Maps key, Google refused, or the run is too big for one
//                 request: stops are ordered by straight-line distance from the
//                 warehouse, nearest first. Not a route, but it keeps a caza
//                 together and costs nothing.
//   3. Neither  — an order whose city resolves to no coordinates keeps a null
//                 sequence and sinks to the bottom of the driver's list, where
//                 it is still visible and still deliverable.
//
// Two properties everything below is written to preserve:
//
//   * It never throws. Resequencing hangs off the assignment endpoint, and a
//     Google outage must not fail the assignment a dispatcher just made.
//   * It never drops an order. A partial or malformed answer from Google is
//     discarded in favour of the distance ordering rather than applied to the
//     stops it happened to cover.

const pool = require("../config/db");
const { getWarehouse } = require("../config/warehouse");
const {
  groupOrdersIntoStops,
  sequenceFromStops,
  applyOptimizedOrder,
} = require("../utils/routeOrder");
const { optimizeStopOrder, isConfigured, MAX_WAYPOINTS } = require("./mapsService");

// The statuses that take an order off the van. Delivered, returned and
// cancelled orders are done with and are not part of the route; the list
// mirrors getOrdersByDriverId, which is the list being ordered.
const FINISHED_STATUSES = ["DELIVERED", "RETURNED", "CANCELLED"];

async function getActiveOrdersForDriver(driverId) {
  const result = await pool.query(
    `SELECT id, city, area, customer_latitude, customer_longitude
     FROM orders
     WHERE assigned_driver_id = $1
       AND order_status <> ALL($2::text[])
     ORDER BY created_at DESC`,
    [driverId, FINISHED_STATUSES]
  );
  return result.rows;
}

// One statement for the whole run: the sequence numbers are unnested alongside
// the ids they belong to, so a driver's list is renumbered atomically rather
// than row by row with the list half-ordered in between.
async function writeSequences(sequences) {
  if (sequences.length === 0) return;

  await pool.query(
    `UPDATE orders AS o
     SET route_sequence = v.sequence
     FROM (
       SELECT UNNEST($1::int[]) AS id, UNNEST($2::int[]) AS sequence
     ) AS v
     WHERE o.id = v.id`,
    [sequences.map((s) => s.orderId), sequences.map((s) => s.sequence)]
  );
}

// Orders that resolved to no coordinates keep no sequence. Clearing matters on
// a re-run: an order that had a sequence before and cannot be placed now — its
// city edited to something unrecognised — must not keep a stale number that
// would sort it into the middle of a route it is no longer part of.
async function clearSequences(orderIds) {
  if (orderIds.length === 0) return;

  await pool.query(
    `UPDATE orders SET route_sequence = NULL WHERE id = ANY($1::int[])`,
    [orderIds]
  );
}

/// Recomputes and stores the route order for one driver's active orders.
///
/// Resolves to a small report — { ok, source, stops, orders } — for logging and
/// for scripts/resequence-routes.js. Callers on the assignment path ignore it;
/// what matters to them is that it never rejects.
async function resequenceDriverRoute(driverId) {
  try {
    const warehouse = getWarehouse();
    const orders = await getActiveOrdersForDriver(driverId);

    if (orders.length === 0) {
      return { ok: true, source: "NONE", stops: 0, orders: 0 };
    }

    const stops = groupOrdersIntoStops(orders, warehouse);
    const placed = new Set(stops.flatMap((stop) => stop.orderIds));
    const unplaced = orders.filter((order) => !placed.has(order.id)).map((order) => order.id);

    if (stops.length === 0) {
      await clearSequences(unplaced);
      return { ok: true, source: "NONE", stops: 0, orders: orders.length };
    }

    // Straight-line order is both the starting point and the fallback: stops
    // arrive from groupOrdersIntoStops already sorted by distance.
    let ordered = stops;
    let source = "DISTANCE";

    if (stops.length > MAX_WAYPOINTS) {
      console.warn(
        `[Route order] Driver ${driverId}: ${stops.length} stops is over Google's ` +
          `${MAX_WAYPOINTS} waypoint limit; using distance order.`
      );
    } else if (isConfigured()) {
      const optimized = await optimizeStopOrder({
        originLat: warehouse.latitude,
        originLng: warehouse.longitude,
        stops: stops.map((stop) => ({ latitude: stop.latitude, longitude: stop.longitude })),
      });

      if (optimized.ok) {
        ordered = applyOptimizedOrder(stops, optimized.order);
        source = "GOOGLE";
      } else {
        console.warn(
          `[Route order] Driver ${driverId}: Google declined (${optimized.status}` +
            `${optimized.message ? `: ${optimized.message}` : ""}); using distance order.`
        );
      }
    }

    await writeSequences(sequenceFromStops(ordered));
    await clearSequences(unplaced);

    return { ok: true, source, stops: ordered.length, orders: orders.length };
  } catch (error) {
    // Swallowed on purpose: this runs off the back of an assignment that has
    // already succeeded, and a driver with an unsorted list is a far smaller
    // problem than a dispatcher told their assignment failed.
    console.error(`[Route order] Driver ${driverId}: resequence failed:`, error.message);
    return { ok: false, source: "ERROR", stops: 0, orders: 0 };
  }
}

// ── Coalescing ──────────────────────────────────────────────────────────────
//
// A dispatcher hands a driver their morning by clicking a dozen orders in a
// row, which is a dozen assignments in a few seconds. Resequencing on each one
// would mean a dozen Directions requests for a route that is only correct after
// the last of them, so an assignment schedules the work rather than doing it,
// and a later assignment within the window replaces the one already waiting.
//
// The delay is short enough that a dispatcher assigning a single order sees the
// run reordered by the time they look at the driver, and long enough to
// collapse a burst of clicking into one call.
const COALESCE_MS = 5000;

const pending = new Map();

/// Schedules a resequence for this driver, replacing any already scheduled.
///
/// Returns nothing and never throws — it is called from write paths that have
/// already committed and must not be undone by a routing problem. The timer is
/// unref'd so it can never hold a shutting-down process open.
function scheduleResequence(driverId) {
  if (driverId == null) return;

  const key = Number(driverId);
  if (!Number.isFinite(key)) return;

  const existing = pending.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pending.delete(key);
    resequenceDriverRoute(key)
      // Logged on the way past, success included. The fallbacks below this are
      // quiet by design — no Maps key configured is not a warning, it is a
      // deployment that has not turned Google on — so without a line here the
      // only way to tell an optimised run from a distance-ordered one would be
      // to read the database. One line per run is cheap: a run is a
      // dispatcher's handover, not a request.
      .then((report) =>
        console.log(
          `[Route order] Driver ${key}: ${report.orders} orders over ` +
            `${report.stops} stops — ${report.source}`
        )
      )
      .catch((error) =>
        console.error(`[Route order] Driver ${key}: scheduled resequence failed:`, error.message)
      );
  }, COALESCE_MS);

  if (typeof timer.unref === "function") timer.unref();
  pending.set(key, timer);
}

module.exports = {
  resequenceDriverRoute,
  scheduleResequence,
  COALESCE_MS,
};
