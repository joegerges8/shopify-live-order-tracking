// etaService.js
//
// Works out when the driver will reach a customer, without the customer ever
// supplying their location.
//
// The destination comes from the order's own city text (see utils/townCoords.js),
// so this works on every order rather than only the ones carrying a pin. The
// estimate is:
//
//   drive time (driver → destination)
//   + handling time × orders the driver has started but not yet delivered
//   + last-mile time
//   floored at a minimum, and widened into a range
//
// The stop term is deliberately conservative: it counts every order the driver
// is carrying, as if this customer were served last. Nothing records the order
// in which a driver works through a batch, so the honest expectation is roughly
// half of them — but quoting late and arriving early keeps a customer's trust,
// while quoting early and arriving late destroys it.
//
// The range is the feature, not a hedge. A town centre is not a doorstep, so a
// single confident number would be false precision; the window widens as the
// destination gets coarser and narrows when the driver has only this one stop.

const { getRoute, isConfigured } = require("./mapsService");
const { resolveDestination, haversineKm } = require("../utils/townCoords");

// Every constant is env-tunable so these can be calibrated against real
// delivery times without a code change. The defaults are starting estimates,
// not measurements — compare predictions against orders.delivered_at after a
// few hundred deliveries and adjust.
const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// Time spent per other order the driver is carrying: park, find the building,
// hand over, collect cash, walk back. Not drive time.
const HANDLING_SECONDS = () => number("ETA_HANDLING_SECONDS", 480);

// The gap between "the centre of the town" and the customer's actual door.
const LAST_MILE_SECONDS = () => number("ETA_LAST_MILE_SECONDS", 240);

// Never show less than this while the order is undelivered. Once the driver is
// inside the town the routed time collapses toward zero, but they are still
// circling looking for the building — counting down to "0 min" and sitting
// there reads as broken.
const MIN_SECONDS = () => number("ETA_MIN_SECONDS", 300);

// Fallback speed when no Directions key is configured. Set ETA_AVG_SPEED_KMH to
// pin a single flat speed; left unset, speed is banded by trip length, because
// one average is wrong at both ends — a 2 km hop across Beirut and a 30 km run
// up the coastal highway are not the same kind of driving. Without the banding
// a flat city speed turned a 35-minute Ballouneh → Amchit trip into 65 minutes.
const SPEED_BANDS = [
  { maxKm: 3, kmh: 15 }, // dense city, lights and parking
  { maxKm: 10, kmh: 25 }, // suburbs
  { maxKm: 30, kmh: 40 }, // mixed, some highway
  { maxKm: Infinity, kmh: 55 }, // mostly highway
];

function speedForDistance(km) {
  const flat = Number(process.env.ETA_AVG_SPEED_KMH);
  if (Number.isFinite(flat) && flat > 0) return flat;
  return SPEED_BANDS.find((band) => km <= band.maxKm).kmh;
}

// Roads are longer than straight lines; scales the haversine fallback.
const ROAD_FACTOR = () => number("ETA_ROAD_FACTOR", 1.3);

// How wide the shown window is, as a fraction either side of the estimate.
// Coarser destination, wider window.
const SPREAD_BY_PRECISION = { EXACT: 0.15, TOWN: 0.25, AREA: 0.4 };

// Recompute no more often than this, and only if the driver actually moved.
// Drivers ping every 15 seconds per order; routing every ping would burn quota
// for no gain.
const CACHE_MS = 60_000;
const MOVED_METERS = 150;

// orderId -> { computedAt, driverLat, driverLng, eta }
const cache = new Map();

// Statuses where a customer should see a moving ETA at all. ASSIGNED is
// excluded on purpose: the order is still at the shop, and the tracking page
// hides the driver at that stage too. Two conditions therefore have to hold
// before a customer sees a time — the dispatcher has marked the order picked
// up, and the driver has tapped "Start Delivery" (see hasDriverStarted).
const ACTIVE_STATUSES = new Set(["PICKED_UP", "OUT_FOR_DELIVERY"]);

function roundToMinutes(date, minutes) {
  const ms = minutes * 60 * 1000;
  return new Date(Math.round(date.getTime() / ms) * ms);
}

function clockTime(date) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: process.env.ETA_TIMEZONE || "Asia/Beirut",
  });
}

// "arriving 6:20 – 6:45 PM" reads better than "6:20 PM – 6:45 PM", so the
// meridiem is dropped from the first bound when both share it.
function formatWindow(start, end) {
  const startText = clockTime(start);
  const endText = clockTime(end);
  const startMeridiem = startText.slice(-2);
  const endMeridiem = endText.slice(-2);

  const left =
    startMeridiem === endMeridiem ? startText.slice(0, -3) : startText;
  return `arriving ${left} – ${endText}`;
}

// Straight-line estimate, used when Directions is unavailable or unconfigured.
// Rough, but it keeps the page useful instead of blank.
function estimateDriveSeconds(fromLat, fromLng, toLat, toLng) {
  const km = haversineKm(fromLat, fromLng, toLat, toLng) * ROAD_FACTOR();
  return (km / speedForDistance(km)) * 3600;
}

function buildEta({ driveSeconds, stopsAhead, destination, source, polyline }) {
  const precision = destination.precision;
  const total = Math.max(
    driveSeconds + stopsAhead * HANDLING_SECONDS() + LAST_MILE_SECONDS(),
    MIN_SECONDS()
  );

  const now = Date.now();
  const arrival = new Date(now + total * 1000);

  // A single remaining stop has far fewer unknowns than a batch, so it earns
  // the tighter window.
  const spread =
    (SPREAD_BY_PRECISION[precision] ?? 0.4) + (stopsAhead > 0 ? 0.05 : 0);

  const windowStart = roundToMinutes(new Date(now + total * (1 - spread) * 1000), 5);
  const windowEnd = roundToMinutes(new Date(now + total * (1 + spread) * 1000), 5);

  return {
    seconds: Math.round(total),
    minutes: Math.round(total / 60),
    arrival_at: arrival.toISOString(),
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    text: formatWindow(windowStart, windowEnd),
    precision,
    source,
    stops_ahead: stopsAhead,
    polyline: polyline || null,
    // Where the driver is actually heading. Sent so the page can show the
    // destination honestly: a sharp pin for a real address, a soft circle for a
    // town centre. It is the customer's own town, so nothing is revealed to them
    // that they did not already tell us.
    destination: {
      latitude: destination.latitude,
      longitude: destination.longitude,
      town: destination.town,
    },
  };
}

// Computes the ETA for one order.
//
// Returns null — meaning "show nothing" — when the order is not on the road,
// when the driver has not started it (no GPS is flowing), or when the city
// resolves to no place we can locate. A blank ETA is better than a wrong one.
async function computeEta({ order, driverLocation, stopsAhead = 0 }) {
  if (!order || !driverLocation) return null;
  if (!ACTIVE_STATUSES.has(order.order_status)) return null;

  const driverLat = Number(driverLocation.latitude);
  const driverLng = Number(driverLocation.longitude);
  if (!Number.isFinite(driverLat) || !Number.isFinite(driverLng)) return null;

  const destination = resolveDestination(order);
  if (!destination) return null;

  const cached = cache.get(order.id);
  if (cached && Date.now() - cached.computedAt < CACHE_MS) {
    const movedKm = haversineKm(cached.driverLat, cached.driverLng, driverLat, driverLng);
    if (movedKm * 1000 < MOVED_METERS && cached.eta.stops_ahead === stopsAhead) {
      return cached.eta;
    }
  }

  let driveSeconds = null;
  let source = "estimate";
  let polyline = null;

  if (isConfigured()) {
    const result = await getRoute({
      originLat: driverLat,
      originLng: driverLng,
      destLat: destination.latitude,
      destLng: destination.longitude,
    });

    if (result.ok) {
      driveSeconds = result.route.durationInTrafficSeconds || result.route.durationSeconds;
      polyline = result.route.polyline;
      source = "directions";
    }
  }

  if (driveSeconds == null) {
    driveSeconds = estimateDriveSeconds(
      driverLat,
      driverLng,
      destination.latitude,
      destination.longitude
    );
  }

  const eta = buildEta({ driveSeconds, stopsAhead, destination, source, polyline });

  cache.set(order.id, {
    computedAt: Date.now(),
    driverLat,
    driverLng,
    eta,
  });

  return eta;
}

// Drops an order's cached ETA. Called when a delivery finishes so a re-opened
// tracking page cannot show a stale countdown.
function clearEta(orderId) {
  cache.delete(orderId);
}

// Whether the driver has actually set off for this order.
//
// The customer only sees an ETA once the driver taps "Start Delivery" in the
// driver app. That tap is local to the app and never reaches the backend, but
// it is exactly what starts the GPS stream — so a recent location ping is the
// signal, with no app change or extra endpoint needed. The dispatcher flipping
// an order to PICKED_UP is a separate step and deliberately does not reveal an
// ETA on its own: the order may be sitting in the shop.
function hasDriverStarted(locationUpdatedAt) {
  if (!locationUpdatedAt) return false;
  const age = Date.now() - new Date(locationUpdatedAt).getTime();
  if (!Number.isFinite(age)) return false;
  return age >= 0 && age <= number("ETA_START_WINDOW_SECONDS", 600) * 1000;
}

// Builds the ETA for an order row shaped like getOrderByTrackingToken's result
// (driver_lat / driver_lng / location_updated_at joined in). This is the entry
// point both the tracking endpoint and the socket push use, so the customer
// sees the same numbers whether their page polled or was pushed to.
//
// Returns null whenever there is nothing honest to show: no driver position,
// the driver has not set off yet, or the city resolves to no place we can find.
async function etaForTrackedOrder(order) {
  if (!order?.driver_lat || !hasDriverStarted(order.location_updated_at)) {
    return null;
  }

  // Required lazily: orderService is a heavier module and only this path needs it.
  const { countStartedDeliveries } = require("./orderService");
  const stopsAhead = await countStartedDeliveries(order.assigned_driver_id, order.id);

  return computeEta({
    order,
    driverLocation: { latitude: order.driver_lat, longitude: order.driver_lng },
    stopsAhead,
  });
}

module.exports = { computeEta, clearEta, hasDriverStarted, etaForTrackedOrder };
