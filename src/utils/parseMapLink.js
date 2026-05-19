const PATTERNS = [
  /@(-?\d+\.?\d*),(-?\d+\.?\d*)/,
  /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
  /[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
  /[?&]center=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
  /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/,
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

  const direct = extractCoords(trimmed);
  if (direct) return direct;

  if (trimmed.includes('goo.gl')) {
    const response = await fetch(trimmed, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    console.log('[parseMapLink] status:', response.status);
    console.log('[parseMapLink] final URL:', response.url);

    const fromUrl = extractCoords(response.url);
    if (fromUrl) return fromUrl;

    const html = await response.text();
    console.log('[parseMapLink] HTML snippet:', html.slice(0, 800));

    const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
                        || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
    if (canonicalMatch) {
      console.log('[parseMapLink] canonical:', canonicalMatch[1]);
      const fromCanonical = extractCoords(canonicalMatch[1]);
      if (fromCanonical) return fromCanonical;
    }

    const ogMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
    if (ogMatch) {
      console.log('[parseMapLink] og:url:', ogMatch[1]);
      const fromOg = extractCoords(ogMatch[1]);
      if (fromOg) return fromOg;
    }

    return extractCoords(html);
  }

  return null;
}

module.exports = { parseMapLink };
