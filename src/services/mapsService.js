// mapsService.js
//
// One place that talks to the Google Directions API. Both callers need the same
// traffic-aware driving route:
//   - the driver app, through GET /api/maps/directions (mapsController), and
//   - the customer ETA, through etaService.
//
// Kept as a service rather than living in the controller so the ETA does not
// have to make an HTTP call to our own API just to reuse the logic.

const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";
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

module.exports = { getRoute, isConfigured };
