const PATTERNS = [
  /@(-?\d+\.?\d*),(-?\d+\.?\d*)/,           // /@lat,lng,zoom
  /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/,      // ?q=lat,lng
  /[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/,     // ?ll=lat,lng
  /[?&]center=(-?\d+\.?\d*),(-?\d+\.?\d*)/, // ?center=lat,lng
  /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/,       // embedded data params
];

function extractCoords(text) {
  for (const pattern of PATTERNS) {
    const m = text.match(pattern);
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

  // Try direct parse first (already a full URL with coords)
  const direct = extractCoords(trimmed);
  if (direct) return direct;

  // Short links need to be expanded
  if (trimmed.includes('goo.gl')) {
    const response = await fetch(trimmed, {
      redirect: 'follow',
      headers: {
        // Without a real User-Agent, Google may not issue a proper redirect
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    // 1. Try the final redirected URL
    const fromUrl = extractCoords(response.url);
    if (fromUrl) return fromUrl;

    // 2. Fall back: scan the HTML body Google returns
    //    Mobile share links (maps.app.goo.gl) often embed coords in
    //    the canonical <link> or og:url <meta> tag rather than the URL
    const html = await response.text();

    const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
                        || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
    if (canonicalMatch) {
      const fromCanonical = extractCoords(canonicalMatch[1]);
      if (fromCanonical) return fromCanonical;
    }

    const ogMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
    if (ogMatch) {
      const fromOg = extractCoords(ogMatch[1]);
      if (fromOg) return fromOg;
    }

    // 3. Last resort: scan the entire HTML (coords appear in JSON-LD or script tags)
    return extractCoords(html);
  }

  return null;
}

module.exports = { parseMapLink };
