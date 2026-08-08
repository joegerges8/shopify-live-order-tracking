const { getRoute } = require("../services/mapsService");

// GET /api/maps/directions — driver-authenticated route lookup used by the
// driver app to draw its navigation line. The Google call itself lives in
// mapsService so the customer ETA can reuse it without going through HTTP.
async function getDirections(req, res) {
  try {
    const originLat = Number(req.query.originLat);
    const originLng = Number(req.query.originLng);
    const destLat = Number(req.query.destLat);
    const destLng = Number(req.query.destLng);

    const result = await getRoute({ originLat, originLng, destLat, destLng });

    if (result.ok) {
      return res.status(200).json(result.route);
    }

    if (result.status === "NOT_CONFIGURED") {
      return res.status(501).json({
        error: "Directions not configured. Set GOOGLE_MAPS_SERVER_KEY on the server.",
      });
    }

    if (result.status === "INVALID_REQUEST") {
      return res.status(400).json({
        error:
          "Invalid coordinates. Provide originLat, originLng, destLat, destLng as numbers.",
      });
    }

    if (result.status === "UNREACHABLE" || result.status.startsWith("HTTP_")) {
      return res.status(502).json({ error: result.message });
    }

    // Google answered but gave us no usable route. Pass its own status and
    // message through so the client can show a meaningful reason (REQUEST_DENIED
    // means the key is wrong or the Directions API is not enabled; ZERO_RESULTS
    // means no road route exists).
    const detail = result.message
      ? ` (${result.status}: ${result.message})`
      : ` (${result.status})`;
    return res.status(400).json({
      error: `No route returned from Google Directions API${detail}`,
      status: result.status,
      message: result.message,
    });
  } catch (e) {
    return res.status(500).json({ error: "Failed to get directions" });
  }
}

module.exports = { getDirections };
