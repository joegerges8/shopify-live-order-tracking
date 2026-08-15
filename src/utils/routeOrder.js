// routeOrder.js
//
// The arithmetic behind a driver's route order: which points a run of orders
// actually visits, in what sequence, and how a sequence turns back into one
// number per order.
//
// Kept apart from routeOrderService, which owns the database and the call to
// Google, because everything here is a pure function of the orders it is given
// — which is what makes it checkable on its own (scripts/check-route-order.js)
// without a database, a Maps key or a network.

const { resolveDestination, haversineKm } = require("./townCoords");

// Stops closer together than this are treated as one point.
//
// Most orders resolve to a town centre rather than a doorstep, so a run of
// twelve orders is often five or six distinct places. Collapsing them keeps a
// big run inside Google's waypoint limit and off its meter, and the orders
// sharing a point keep their order relative to each other.
//
// Four decimals is about eleven metres: near enough that only genuinely
// identical points collapse, so two real doorsteps on the same street stay two
// stops.
const POINT_PRECISION = 4;

function pointKey(latitude, longitude) {
  return `${latitude.toFixed(POINT_PRECISION)},${longitude.toFixed(POINT_PRECISION)}`;
}

/// Collapses orders onto the distinct points they are delivered to.
///
/// Returns [{ latitude, longitude, km, orderIds }], nearest the warehouse
/// first. That distance order is both the fallback sequence — used whenever
/// Google cannot be reached — and what decides which stops fit under the
/// waypoint cap, so it is computed even when Google is about to reorder
/// everything anyway.
///
/// Orders that resolve to no coordinates are left out entirely rather than
/// piled onto some default point; the caller keeps them unsequenced, which
/// sorts them to the bottom of the driver's list.
function groupOrdersIntoStops(orders, warehouse) {
  const stops = new Map();

  for (const order of orders) {
    const destination = resolveDestination(order);
    if (!destination) continue;

    const latitude = Number(destination.latitude);
    const longitude = Number(destination.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const key = pointKey(latitude, longitude);
    const existing = stops.get(key);
    if (existing) {
      existing.orderIds.push(order.id);
    } else {
      stops.set(key, {
        latitude,
        longitude,
        orderIds: [order.id],
        km: haversineKm(warehouse.latitude, warehouse.longitude, latitude, longitude),
      });
    }
  }

  return [...stops.values()].sort((a, b) => a.km - b.km);
}

/// Flattens ordered stops into one sequence number per order, counting from 1.
///
/// Orders sharing a stop are numbered consecutively in the order they were
/// grouped, which is the order the database returned them in — stable, so a
/// resequence that moves no stop rewrites no row to a different number.
function sequenceFromStops(stops) {
  const sequences = [];
  let next = 1;

  for (const stop of stops) {
    for (const orderId of stop.orderIds) {
      sequences.push({ orderId, sequence: next });
      next += 1;
    }
  }

  return sequences;
}

/// Reorders stops by the indexes Google returned.
///
/// The indexes are validated by mapsService before they get here — every stop
/// exactly once — so this is only the mapping, kept named so the step from
/// "Google's answer" to "the driver's run" is legible where it happens.
function applyOptimizedOrder(stops, order) {
  return order.map((index) => stops[index]);
}

module.exports = {
  POINT_PRECISION,
  groupOrdersIntoStops,
  sequenceFromStops,
  applyOptimizedOrder,
};
