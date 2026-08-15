// mapsService.js
//
// One place that talks to the Google Directions API. Both callers need the same
// traffic-aware driving route:
//   - the driver app, through GET /api/maps/directions (mapsController), and
//   - the customer ETA, through etaService.
//
// Kept as a service rather than living in the controller so the ETA does not
// have to make an HTTP call to our own API just to reuse the logic.

const { nearestTown } = require("../utils/townCoords");

const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const REQUEST_TIMEOUT_MS = 10000;

function serverKey() {
  return (process.env.GOOGLE_MAPS_SERVER_KEY || "").trim();
}

// True when the server can call Google at all. Callers use this to decide
// whether to attempt a route or go straight to their own fallback — the key is
// optional, and the app is expected to work without it.
function isConfigured() {
  return serverKey().length > 0;
}

// Fetches a driving route between two points.
//
// Resolves to { ok: true, route } or { ok: false, status, message } — it never
// throws for an upstream failure, because every caller wants to degrade rather
// than fail. `status` carries Google's own status ("REQUEST_DENIED",
// "ZERO_RESULTS", …) so the driver app can show a meaningful reason.
async function getRoute({ originLat, originLng, destLat, destLng }) {
  const key = serverKey();
  if (!key) {
    return {
      ok: false,
      status: "NOT_CONFIGURED",
      message: "GOOGLE_MAPS_SERVER_KEY is not set on the server.",
    };
  }

  const nums = [originLat, originLng, destLat, destLng];
  if (nums.some((n) => !Number.isFinite(n))) {
    return {
      ok: false,
      status: "INVALID_REQUEST",
      message: "Coordinates must be finite numbers.",
    };
  }

  const url = new URL(DIRECTIONS_URL);
  url.searchParams.set("origin", `${originLat},${originLng}`);
  url.searchParams.set("destination", `${destLat},${destLng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("departure_time", "now");
  url.searchParams.set("traffic_model", "best_guess");
  url.searchParams.set("key", key);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url.toString(), { signal: controller.signal });
  } catch (error) {
    return {
      ok: false,
      status: "UNREACHABLE",
      message: error?.name === "AbortError" ? "Directions request timed out" : "Directions request failed",
    };
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      status: `HTTP_${response.status}`,
      message: data?.error_message || `Directions request failed (HTTP ${response.status})`,
    };
  }

  if (!data || data.status !== "OK" || !Array.isArray(data.routes) || data.routes.length === 0) {
    return {
      ok: false,
      status: data?.status ?? "UNKNOWN",
      message: data?.error_message ?? "",
    };
  }

  const route = data.routes[0];
  const leg = route?.legs?.[0];

  return {
    ok: true,
    route: {
      polyline: route?.overview_polyline?.points ?? "",
      distanceText: leg?.distance?.text ?? "",
      distanceMeters: leg?.distance?.value ?? 0,
      durationText: leg?.duration?.text ?? "",
      durationSeconds: leg?.duration?.value ?? 0,
      durationInTrafficText: leg?.duration_in_traffic?.text ?? leg?.duration?.text ?? "",
      durationInTrafficSeconds:
        leg?.duration_in_traffic?.value ?? leg?.duration?.value ?? 0,
    },
  };
}

// ── Waypoint optimisation ───────────────────────────────────────────────────
//
// The order to drive a set of stops in, which is what puts a driver's list in
// route order instead of in the order the dispatcher happened to assign them.
//
// Google solves this itself: `waypoints=optimize:true|...` on a Directions
// request returns `waypoint_order`, the stops resequenced into the shortest
// driving route. It is a real travelling-salesman solve over the road network,
// so it accounts for the motorway, the one-ways and the mountain that a
// straight-line sort cannot see.
//
// The route is modelled as a round trip: origin and destination are both the
// warehouse, because the van leaves from there and comes back. That is also
// what makes every stop optimisable — naming one of them as the destination
// would pin it last however far out of the way it is.

// Google's cap on waypoints in a single Directions request. Callers are
// expected to have collapsed stops onto distinct points first (see
// routeOrderService), which keeps all but the largest runs under it.
const MAX_WAYPOINTS = 25;

// Returns { ok: true, order } where `order` is the indexes of `stops` in the
// sequence they should be driven, or { ok: false, status, message }.
//
// Like getRoute it never throws: the caller has a straight-line fallback and a
// Google outage must cost route ordering, not the assignment that triggered it.
async function optimizeStopOrder({ originLat, originLng, stops }) {
  const key = serverKey();
  if (!key) {
    return {
      ok: false,
      status: "NOT_CONFIGURED",
      message: "GOOGLE_MAPS_SERVER_KEY is not set on the server.",
    };
  }

  if (!Array.isArray(stops) || stops.length === 0) {
    return { ok: true, order: [] };
  }

  // One stop has only one possible order, and asking Google to confirm that
  // costs a request. Two stops likewise: whichever is nearer the warehouse
  // comes first either way, and the caller has already sorted by that.
  if (stops.length <= 2) {
    return { ok: true, order: stops.map((_, index) => index) };
  }

  if (stops.length > MAX_WAYPOINTS) {
    return {
      ok: false,
      status: "TOO_MANY_WAYPOINTS",
      message: `${stops.length} stops exceeds Google's limit of ${MAX_WAYPOINTS} per request.`,
    };
  }

  const coordinates = [originLat, originLng, ...stops.flatMap((s) => [s.latitude, s.longitude])];
  if (coordinates.some((n) => !Number.isFinite(Number(n)))) {
    return {
      ok: false,
      status: "INVALID_REQUEST",
      message: "Coordinates must be finite numbers.",
    };
  }

  const origin = `${originLat},${originLng}`;
  const url = new URL(DIRECTIONS_URL);
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", origin);
  url.searchParams.set("mode", "driving");
  url.searchParams.set(
    "waypoints",
    `optimize:true|${stops.map((s) => `${s.latitude},${s.longitude}`).join("|")}`
  );
  url.searchParams.set("key", key);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url.toString(), { signal: controller.signal });
  } catch (error) {
    return {
      ok: false,
      status: "UNREACHABLE",
      message: error?.name === "AbortError" ? "Optimisation request timed out" : "Optimisation request failed",
    };
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      status: `HTTP_${response.status}`,
      message: data?.error_message || `Optimisation request failed (HTTP ${response.status})`,
    };
  }

  if (!data || data.status !== "OK" || !Array.isArray(data.routes) || data.routes.length === 0) {
    return {
      ok: false,
      status: data?.status ?? "UNKNOWN",
      message: data?.error_message ?? "",
    };
  }

  const order = data.routes[0]?.waypoint_order;

  // A route without waypoint_order, or one naming a stop twice or not at all,
  // would silently drop orders off the driver's list if it were trusted. The
  // caller's fallback ordering is wrong-but-complete, which is the better of
  // the two failures.
  if (!Array.isArray(order) || order.length !== stops.length) {
    return {
      ok: false,
      status: "NO_WAYPOINT_ORDER",
      message: "Google returned a route without a usable waypoint order.",
    };
  }

  const seen = new Set(order);
  if (seen.size !== stops.length || order.some((i) => !Number.isInteger(i) || i < 0 || i >= stops.length)) {
    return {
      ok: false,
      status: "BAD_WAYPOINT_ORDER",
      message: "Google's waypoint order did not cover every stop exactly once.",
    };
  }

  return { ok: true, order };
}

// ── Reverse geocoding ───────────────────────────────────────────────────────
//
// Turning a driver's coordinates into the name of the town they are in, for
// the dispatcher's live map. The delivery city is already on the order; this
// answers the different question of where the driver actually is right now.

// Coordinates are rounded to this many decimals before being used as a cache
// key. Two decimals is roughly a kilometre — coarser than any town, so a
// driver crossing one asks Google a handful of times rather than once every
// fifteen seconds, and the answer is the same town either way. The cost of the
// rounding is only at a boundary, where the name may flip a street early.
const GEOCODE_PRECISION = 2;

// Town names do not change, so the lifetime here is about bounding memory and
// not about freshness. The cap evicts oldest-first once a busy fleet has
// wandered over enough of the map.
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOCODE_CACHE_LIMIT = 5000;

const geocodeCache = new Map();

function cacheKey(lat, lng) {
  return `${lat.toFixed(GEOCODE_PRECISION)},${lng.toFixed(GEOCODE_PRECISION)}`;
}

function readCache(key) {
  const hit = geocodeCache.get(key);
  if (!hit) return undefined;

  if (Date.now() - hit.at > GEOCODE_TTL_MS) {
    geocodeCache.delete(key);
    return undefined;
  }

  return hit.city;
}

function writeCache(key, city) {
  // Map iterates in insertion order, so the first key is the oldest.
  if (geocodeCache.size >= GEOCODE_CACHE_LIMIT) {
    const oldest = geocodeCache.keys().next().value;
    geocodeCache.delete(oldest);
  }
  geocodeCache.set(key, { city, at: Date.now() });
}

// Which address component to call "the town", most specific first. Google
// returns a stack of them for one point — a street, a neighbourhood, a town, a
// district, a governorate — and the useful one for "where is my driver" is the
// smallest named place a dispatcher would recognise.
const PLACE_TYPES = [
  "locality",
  "administrative_area_level_3",
  "sublocality",
  "neighborhood",
  "administrative_area_level_2",
];

function pickPlaceName(results) {
  if (!Array.isArray(results)) return null;

  for (const type of PLACE_TYPES) {
    for (const result of results) {
      const components = result?.address_components;
      if (!Array.isArray(components)) continue;

      const match = components.find(
        (component) => Array.isArray(component.types) && component.types.includes(type)
      );
      if (match?.long_name) return match.long_name;
    }
  }

  return null;
}

// The town a coordinate falls in, as { name, precision }, or null when it
// cannot be worked out at all.
//
// Never throws and never rejects: the live map calls this for every driver on
// every poll, and a Google outage has to cost a line of text, not the map.
//
// Two very different answers can come back, and the caller is told which:
//
//   EXACT       — Google named the place the coordinates are actually in.
//   APPROXIMATE — Google could not be asked (no GOOGLE_MAPS_SERVER_KEY, quota
//                 exhausted, request timed out) or had nothing there, so the
//                 local town table answered with the nearest town centre it
//                 knows. That table holds a few hundred points, so near a
//                 boundary it will name the village next door: a driver in
//                 Ballouneh comes back as Jeita. Useful, but not the truth,
//                 and the dashboard says "Near Jeita" rather than "In Jeita"
//                 so nobody reads it as one.
async function reverseGeocodeCity(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const fromGoogle = await googleReverseGeocodeCity(lat, lng);
  if (fromGoogle) return { name: fromGoogle, precision: "EXACT" };

  const nearest = nearestTown(lat, lng);
  return nearest ? { name: nearest, precision: "APPROXIMATE" } : null;
}

// Google's own answer, or null. Split out so the fallback above reads as one
// line and every "we could not find out" path lands in the same place.
async function googleReverseGeocodeCity(lat, lng) {
  const key = cacheKey(lat, lng);
  const cached = readCache(key);
  // A previous lookup that found nothing is cached as null and honoured here,
  // so a driver parked in the middle of nowhere is not re-asked about forever.
  if (cached !== undefined) return cached;

  const apiKey = serverKey();
  if (!apiKey) return null;

  const url = new URL(GEOCODE_URL);
  url.searchParams.set("latlng", `${lat},${lng}`);
  // The dashboard is in English; without this Google answers in the script of
  // whatever region the point is in, which puts Arabic town names on an
  // otherwise English page.
  url.searchParams.set("language", "en");
  url.searchParams.set("key", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data || (data.status !== "OK" && data.status !== "ZERO_RESULTS")) {
      // A refused key or an exhausted quota is a server-side problem worth
      // seeing in the logs, but it is not cached — the next poll may succeed.
      if (data?.status && data.status !== "ZERO_RESULTS") {
        console.error(
          `[Geocode] ${data.status}${data.error_message ? `: ${data.error_message}` : ""}`
        );
      }
      return null;
    }

    const city = pickPlaceName(data.results);
    writeCache(key, city);
    return city;
  } catch (error) {
    // Timeout or network failure. Not cached, for the same reason.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  getRoute,
  isConfigured,
  reverseGeocodeCity,
  optimizeStopOrder,
  MAX_WAYPOINTS,
};
