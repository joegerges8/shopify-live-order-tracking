const PATTERNS = [
  /@(-?\d+\.?\d*),(-?\d+\.?\d*)/,           // /@lat,lng,zoom
  /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/,      // ?q=lat,lng
  /[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/,     // ?ll=lat,lng
  /[?&]center=(-?\d+\.?\d*),(-?\d+\.?\d*)/, // ?center=lat,lng
  /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/,       // embedded data params
];

function extractCoords(url) {
  for (const pattern of PATTERNS) {
    const m = url.match(pattern);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

async function parseMapLink(url) {
  const trimmed = url.trim();

  const direct = extractCoords(trimmed);
  if (direct) return direct;

  // Short links (goo.gl/maps or maps.app.goo.gl) need to be expanded first
  if (trimmed.includes('goo.gl')) {
    const response = await fetch(trimmed, { redirect: 'follow' });
    return extractCoords(response.url);
  }

  return null;
}

module.exports = { parseMapLink };
