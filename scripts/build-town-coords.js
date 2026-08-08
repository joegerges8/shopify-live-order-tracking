// build-town-coords.js
//
// Maintains src/data/town-coords.json — the town-centre coordinates the ETA
// calculation uses as the delivery destination when an order has no exact
// customer pin.
//
// Why a file and not a per-order geocode: the set of towns is bounded (the keys
// of TOWN_TO_AREA in src/utils/areaLookup.js) and effectively static, while
// orders are unbounded. Geocoding the town list once and committing the result
// means the ETA costs nothing per order and keeps working when the Geocoding
// API is unreachable or unconfigured.
//
// Usage:
//   node scripts/build-town-coords.js              # report coverage, no writes
//   node scripts/build-town-coords.js --fill       # geocode missing towns
//   node scripts/build-town-coords.js --verify     # re-geocode existing towns
//                                                  # and report ones that moved
//
// --fill and --verify need GOOGLE_MAPS_SERVER_KEY. Both write the file sorted
// so diffs stay readable; --verify never overwrites a coordinate on its own,
// it only prints what disagrees, because the committed values are hand-checked
// and Google occasionally resolves a small Lebanese town to the wrong country.

const fs = require("fs");
const path = require("path");
const { TOWN_TO_AREA, resolveTown } = require("../src/utils/areaLookup");

const COORDS_PATH = path.join(__dirname, "../src/data/town-coords.json");
const HISTORY_PATH = path.join(__dirname, "./city-history.json");

// Every coordinate must land inside this box or it is not in Lebanon and is
// rejected. Google will happily return a same-named town in Syria or France.
const LEBANON_BOUNDS = { minLat: 33.0, maxLat: 34.75, minLng: 35.0, maxLng: 36.7 };

const README_KEY = "_readme";

function loadCoords() {
  const raw = JSON.parse(fs.readFileSync(COORDS_PATH, "utf8"));
  const readme = raw[README_KEY];
  delete raw[README_KEY];
  return { coords: raw, readme };
}

function saveCoords(coords, readme) {
  const sorted = {};
  if (readme) sorted[README_KEY] = readme;
  for (const key of Object.keys(coords).sort()) sorted[key] = coords[key];
  fs.writeFileSync(COORDS_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

function inLebanon([lat, lng]) {
  return (
    lat >= LEBANON_BOUNDS.minLat &&
    lat <= LEBANON_BOUNDS.maxLat &&
    lng >= LEBANON_BOUNDS.minLng &&
    lng <= LEBANON_BOUNDS.maxLng
  );
}

// Straight-line distance in km, used to report how far a stored coordinate is
// from what Google says today.
function haversineKm([lat1, lng1], [lat2, lng2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Orders per town key, from the committed 3-year history. Used to report
// coverage in the terms that matter — share of real orders, not share of keys.
function orderVolumeByTown() {
  const volume = {};
  let total = 0;
  let unresolved = 0;

  let history;
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return { volume, total, unresolved };
  }

  for (const [city, count] of history) {
    total += count;
    const town = resolveTown(city);
    if (!town) {
      unresolved += count;
      continue;
    }
    volume[town] = (volume[town] || 0) + count;
  }

  return { volume, total, unresolved };
}

async function geocodeTown(town, key) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", `${town}, Lebanon`);
  url.searchParams.set("components", "country:LB");
  url.searchParams.set("key", key);

  const response = await fetch(url.toString());
  const data = await response.json().catch(() => null);

  if (!data || data.status !== "OK" || !data.results?.length) {
    return { error: data?.status || `HTTP ${response.status}` };
  }

  const location = data.results[0].geometry?.location;
  if (!location) return { error: "NO_GEOMETRY" };

  const coords = [
    Number(location.lat.toFixed(4)),
    Number(location.lng.toFixed(4)),
  ];
  if (!inLebanon(coords)) return { error: `OUTSIDE_LEBANON ${coords}` };

  return { coords };
}

async function main() {
  const mode = process.argv.includes("--fill")
    ? "fill"
    : process.argv.includes("--verify")
      ? "verify"
      : "report";

  const { coords, readme } = loadCoords();
  const townKeys = Object.keys(TOWN_TO_AREA);
  const { volume, total, unresolved } = orderVolumeByTown();

  const stale = Object.keys(coords).filter((key) => !TOWN_TO_AREA[key]);
  const missing = townKeys.filter((key) => !coords[key]);
  const outOfBounds = Object.entries(coords).filter(([, c]) => !inLebanon(c));

  const coveredVolume = Object.entries(volume)
    .filter(([town]) => coords[town])
    .reduce((sum, [, count]) => sum + count, 0);

  console.log(`towns in table:   ${townKeys.length}`);
  console.log(`with coordinates: ${townKeys.length - missing.length}`);
  console.log(`missing:          ${missing.length}`);
  if (total > 0) {
    const pct = ((coveredVolume / total) * 100).toFixed(1);
    const unresolvedPct = ((unresolved / total) * 100).toFixed(1);
    console.log(
      `history coverage: ${coveredVolume}/${total} orders (${pct}%), ` +
        `${unresolvedPct}% of orders have a city that matches no town at all`
    );
  }

  if (stale.length) {
    console.log(`\nstale keys (not in TOWN_TO_AREA — delete these):`);
    for (const key of stale) console.log(`  ${key}`);
  }

  if (outOfBounds.length) {
    console.log(`\noutside Lebanon (wrong coordinates):`);
    for (const [key, c] of outOfBounds) console.log(`  ${key} ${c}`);
  }

  if (mode === "report") {
    // List what is missing, busiest first, so hand-seeding can be prioritised.
    const ranked = missing
      .map((town) => [town, volume[town] || 0])
      .sort((a, b) => b[1] - a[1]);
    if (ranked.length) {
      console.log(`\nmissing towns (orders in history, busiest first):`);
      for (const [town, count] of ranked.slice(0, 40)) {
        console.log(`  ${town}: ${count}`);
      }
      if (ranked.length > 40) console.log(`  … and ${ranked.length - 40} more`);
    }
    console.log(`\nRun with --fill (and GOOGLE_MAPS_SERVER_KEY set) to geocode them.`);
    return;
  }

  const key = (process.env.GOOGLE_MAPS_SERVER_KEY || "").trim();
  if (!key) {
    console.error("\nGOOGLE_MAPS_SERVER_KEY is not set — nothing to geocode.");
    process.exit(1);
  }

  const targets = mode === "fill" ? missing : Object.keys(coords);
  console.log(`\n${mode}: geocoding ${targets.length} towns…`);

  let written = 0;
  let failed = 0;
  const moved = [];

  for (const town of targets) {
    const { coords: geocoded, error } = await geocodeTown(town, key);
    if (error) {
      failed += 1;
      console.log(`  ✗ ${town}: ${error}`);
      continue;
    }

    if (mode === "fill") {
      coords[town] = geocoded;
      written += 1;
    } else {
      const distance = haversineKm(coords[town], geocoded);
      if (distance > 3) {
        moved.push([town, coords[town], geocoded, distance]);
      }
    }

    // Stay well inside Google's rate limit — this runs rarely and unattended.
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (mode === "fill") {
    saveCoords(coords, readme);
    console.log(`\nwrote ${written} towns, ${failed} failed.`);
  } else {
    console.log(`\n${moved.length} towns disagree with Google by more than 3 km:`);
    for (const [town, stored, google, distance] of moved) {
      console.log(
        `  ${town}: stored ${stored} vs google ${google} (${distance.toFixed(1)} km)`
      );
    }
    console.log(`\nReview each before editing — the stored values are hand-checked.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
