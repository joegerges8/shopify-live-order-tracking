async function getDirections(req, res) {
  try {
    const key = (process.env.GOOGLE_MAPS_SERVER_KEY || '').trim();
    if (!key) {
      return res.status(501).json({
        error:
          'Directions not configured. Set GOOGLE_MAPS_SERVER_KEY on the server.',
      });
    }

    const originLat = Number(req.query.originLat);
    const originLng = Number(req.query.originLng);
    const destLat = Number(req.query.destLat);
    const destLng = Number(req.query.destLng);

    const nums = [originLat, originLng, destLat, destLng];
    if (nums.some((n) => !Number.isFinite(n))) {
      return res.status(400).json({
        error:
          'Invalid coordinates. Provide originLat, originLng, destLat, destLng as numbers.',
      });
    }

    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', `${originLat},${originLng}`);
    url.searchParams.set('destination', `${destLat},${destLng}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('key', key);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let resp;
    try {
      resp = await fetch(url.toString(), { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      return res.status(502).json({
        error: `Directions request failed (HTTP ${resp.status})`,
        details: data,
      });
    }

    if (!data || data.status !== 'OK' || !Array.isArray(data.routes) || data.routes.length === 0) {
      return res.status(400).json({
        error: 'No route returned from Google Directions API',
        status: data?.status,
        message: data?.error_message,
      });
    }

    const polyline = data.routes[0]?.overview_polyline?.points;
    if (!polyline || typeof polyline !== 'string') {
      return res.status(400).json({ error: 'Missing polyline in Directions response' });
    }

    return res.status(200).json({ polyline });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to get directions' });
  }
}

module.exports = { getDirections };
