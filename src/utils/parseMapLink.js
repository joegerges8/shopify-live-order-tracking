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

function extractCoordsFromHtml(html) {
  // 1. Try URL patterns (works for pin-drop share links)
  const fromPatterns = extractCoords(html);
  if (fromPatterns) return fromPatterns;

  // 2. Schema.org microdata: <meta itemprop="latitude" content="33.94">
  const latMeta = html.match(/itemprop=["']latitude["'][^>]*content=["']([^"']+)["']/i)
               || html.match(/content=["']([^"']+)["'][^>]*itemprop=["']latitude["']/i);
  const lngMeta = html.match(/itemprop=["']longitude["'][^>]*content=["']([^"']+)["']/i)
               || html.match(/content=["']([^"']+)["'][^>]*itemprop=["']longitude["']/i);
  if (latMeta && lngMeta) {
    const lat = parseFloat(latMeta[1]);
    const lng = parseFloat(lngMeta[1]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }

  // 3. JSON-LD / script data: "latitude":33.94,"longitude":35.67
  const jsonLat = html.match(/"latitude"\s*:\s*(-?\d+\.?\d*)/);
  const jsonLng = html.match(/"longitude"\s*:\s*(-?\d+\.?\d*)/);
  if (jsonLat && jsonLng) {
    const lat = parseFloat(jsonLat[1]);
    const lng = parseFloat(jsonLng[1]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }

  return null;
}

async function parseMapLink(url) {
  const trimmed = url.trim();

  // Accept raw coordinates: "33.94861, 35.67228" or "33.94861,35.67228"
  const rawCoords = trimmed.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (rawCoords) {
    const lat = parseFloat(rawCoords[1]);
    const lng = parseFloat(rawCoords[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }

  // Try direct parse (already a full URL with coords in it)
  const direct = extractCoords(trimmed);
  if (direct) return direct;

  // Short links need to be fetched and expanded
  if (trimmed.includes('goo.gl')) {
    const response = await fetch(trimmed, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    // 1. Try the final redirected URL
    const fromUrl = extractCoords(response.url);
    if (fromUrl) return fromUrl;

    // 2. Scan the full HTML body (handles place pages with Schema.org microdata)
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

    // Full HTML scan: microdata, JSON-LD, and URL patterns anywhere in the page
    return extractCoordsFromHtml(html);
  }

  return null;
}

module.exports = { parseMapLink };
