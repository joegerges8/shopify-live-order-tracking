// townCoords.js
//
// Turns an order's delivery address into coordinates the ETA can route to,
// without ever asking the customer for a pin or a Google Maps link.
//
// The chain is deliberately layered, most precise first:
//
//   1. TOWN  — the city string resolves to a town in areaLookup's table and
//              that town has a centre in town-coords.json. This is the normal
//              case: 95% of three years of real orders land here.
//   2. AREA  — the city matched no town (or the town has no coordinates yet),
//              but the order carries an area (caza). Much coarser — a caza is
//              tens of kilometres across — but still better than nothing.
//   3. null  — nothing resolvable. The caller shows no ETA rather than a
//              made-up one.
//
// The precision label travels with the coordinates because the ETA widens its
// window to match: a town centre earns a tighter range than a caza centroid.

const TOWN_COORDS = require("../data/town-coords.json");
const { resolveTown, TOWN_TO_AREA, normalize } = require("./areaLookup");

// Centre of each caza, used when the city text resolves to no known town.
// Deliberately coarse — this is the "we know roughly where, not where" tier.
const AREA_CENTROIDS = {
  Beirut: [33.8938, 35.5018],
  Baabda: [33.8339, 35.5442],
  Metn: [33.88, 35.6],
  Keserwan: [33.9808, 35.66],
  Jbeil: [34.1233, 35.6519],
  Aley: [33.8103, 35.5981],
  Chouf: [33.6739, 35.5522],
  Batroun: [34.2553, 35.6581],
  Koura: [34.2969, 35.8083],
  Tripoli: [34.4367, 35.8497],
  Zgharta: [34.3989, 35.8944],
  Bsharri: [34.2506, 36.0106],
  "Minieh-Danniyeh": [34.45, 36.0],
  Akkar: [34.5439, 36.08],
  Zahle: [33.8463, 35.9019],
  "West Bekaa": [33.65, 35.7833],
  Rachaya: [33.5008, 35.8442],
  Baalbek: [34.0058, 36.2181],
  Hermel: [34.3931, 36.3861],
  Saida: [33.5571, 35.3729],
  Jezzine: [33.5439, 35.5789],
  Sour: [33.2705, 35.2038],
  Nabatieh: [33.3789, 35.4839],
  "Bint Jbeil": [33.12, 35.43],
  Marjeyoun: [33.36, 35.59],
  Hasbaya: [33.3978, 35.6853],
};

// Straight-line distance in kilometres. Used both to decide whether the driver
// has moved far enough to be worth re-routing, and as the basis of the ETA
// fallback when no Directions key is configured.
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Coordinates for a town key, or null when the table has no entry for it.
// Missing entries are expected — run scripts/build-town-coords.js to fill them.
function getTownCoords(town) {
  const coords = town ? TOWN_COORDS[town] : null;
  return coords ? { latitude: coords[0], longitude: coords[1] } : null;
}

function getAreaCoords(area) {
  const coords = area ? AREA_CENTROIDS[area] : null;
  return coords ? { latitude: coords[0], longitude: coords[1] } : null;
}

// ── Coordinates back to a town name ─────────────────────────────────────────
//
// The reverse of everything above, and the only way the dispatcher's map can
// caption a driver with a place name when Google is not answering: no key
// configured, quota exhausted, or the request timed out. The same table that
// turns "Jounieh" into a point turns a point back into "Jounieh".
//
// It is an approximation and is meant to read as one — the nearest town centre
// to the driver, not the street they are on. Over a table this dense that is
// the right town almost always, and the alternative on the map is a blank.

// Beyond this the nearest town centre stops being a useful description of
// where someone is. A driver on the coastal motorway is within a few
// kilometres of somewhere named; one this far from every entry in the table is
// out in the mountains, over a border, or at sea, and no name is better than a
// misleading one.
const NEAREST_TOWN_MAX_KM = 15;

// Table keys are lowercase slugs ("ras el metn"), but this ends up on screen.
// The joining words stay lowercase, which is how these names are written.
const LOWERCASE_WORDS = new Set(["el", "al", "le", "la", "de", "du"]);

function titleCaseTown(key) {
  return String(key)
    .split(/\s+/)
    .map((word, index) =>
      index > 0 && LOWERCASE_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(" ");
}

// The table is keyed by every spelling three years of orders threw at it, so
// one town centre often has several keys on it — "beirut", "bayrout",
// "beyrouth", and a couple of outright typos, all on the same point. Which one
// wins is decided below by taking the first alphabetically, which is stable
// but occasionally lands on the odd one out. These are the places where that
// happens often enough to be worth naming properly, since this text goes on
// screen next to a driver's name.
const DISPLAY_NAMES = {
  aalay: "Aley",
  aanout: "Deir el Qamar",
  akar: "Akkar",
  "ash shuwayfat": "Choueifat",
  bayrout: "Beirut",
  bcharre: "Bsharri",
  dabye: "Dbayeh",
  dekouane: "Dekwaneh",
  "forn el chebbak": "Furn el Chebbak",
  hadat: "Hadath",
  jounie: "Jounieh",
  maten: "Metn",
  "sen el fil": "Sin el Fil",
  zouk: "Zouk Mosbeh",
};

// Built once: the JSON carries a "_readme" key alongside the towns, and the
// scan below runs for every driver on every poll.
//
// Sorted so that a coordinate shared by several spellings always resolves to
// the same one, and the Arabic-script keys are dropped — they are there to
// match what a customer typed at checkout, and the dashboard is in English.
const TOWN_POINTS = Object.entries(TOWN_COORDS)
  .filter(
    ([town, value]) =>
      Array.isArray(value) && value.length === 2 && /^[a-z][a-z\s'-]*$/.test(town)
  )
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([town, [latitude, longitude]]) => ({
    name: DISPLAY_NAMES[town] || titleCaseTown(town),
    latitude,
    longitude,
  }));

// The nearest known town to a coordinate, or null when nothing is close
// enough to be worth naming.
function nearestTown(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  let best = null;
  let bestKm = Infinity;

  for (const point of TOWN_POINTS) {
    const km = haversineKm(lat, lng, point.latitude, point.longitude);
    if (km < bestKm) {
      bestKm = km;
      best = point;
    }
  }

  return best && bestKm <= NEAREST_TOWN_MAX_KM ? best.name : null;
}

// ── Which town an order is actually in ──────────────────────────────────────
//
// The city column is the obvious place to look, and for most orders it is
// enough. But two real orders showed its limits on the same day:
//
//   * city "Beirut", address "Achrafieh, Bourj elghazel …" — the city resolves
//     cleanly, to the centre of municipal Beirut, and the driver sees a pin in
//     Bachoura for a customer in Achrafieh. The customer put the real
//     neighbourhood in the address, where nothing was reading it.
//
//   * city "Fanar next to bonjus company" — customers type sentences into the
//     city field, and the address ("Fanar Lebanon") is sometimes the cleaner
//     of the two.
//
// So the town is resolved from both, and the address is allowed to override
// the city only under strict conditions:
//
//   * The city's town must be caza-wide — a key like "beirut" that IS its own
//     area. A customer who wrote a specific town ("Jounieh") is believed over
//     whatever their street address happens to mention; one who wrote a whole
//     caza almost always lives somewhere more specific inside it.
//
//   * The address's town must be near the city's — within [MAX_REFINEMENT_KM].
//     Streets are named after far-away places ("Tripoli street" exists in
//     Beirut), and a refinement that can move a pin 80 km is worse than none.
//     The cap keeps the worst case inside the same urban area.
//
// When the city resolves to nothing at all, the address is taken as-is — the
// alternative today is a caza centroid or no pin whatsoever.

// Generous for one urban area, far too small to reach another region's
// namesake street victimlessly — Beirut to Tripoli is ~80 km.
const MAX_REFINEMENT_KM = 12;

// True for a town key that is just its own caza — normalize('Beirut') is
// 'beirut', so city "Beirut" says which caza, not which neighbourhood.
function isCazaWideTown(town) {
  return town != null && normalize(TOWN_TO_AREA[town]) === town;
}

function resolveOrderTown(order) {
  const cityTown = resolveTown(order?.city);
  const addressTown = resolveTown(order?.shipping_address);

  if (!cityTown) return addressTown;
  if (!addressTown || addressTown === cityTown) return cityTown;
  if (!isCazaWideTown(cityTown)) return cityTown;

  const cityCoords = getTownCoords(cityTown);
  const addressCoords = getTownCoords(addressTown);
  if (!cityCoords || !addressCoords) return cityTown;

  const km = haversineKm(
    cityCoords.latitude,
    cityCoords.longitude,
    addressCoords.latitude,
    addressCoords.longitude
  );
  return km <= MAX_REFINEMENT_KM ? addressTown : cityTown;
}

// Resolves an order to the point the driver is heading for.
//
// An exact customer pin, when one happens to exist, always wins: some orders
// carry latitude/longitude from Shopify note attributes or a dispatcher-pasted
// map link, and those are the real doorstep rather than a town centre.
function resolveDestination(order) {
  const lat = order?.customer_latitude;
  const lng = order?.customer_longitude;
  if (lat != null && lng != null) {
    return {
      latitude: Number(lat),
      longitude: Number(lng),
      precision: "EXACT",
      town: null,
    };
  }

  const town = resolveOrderTown(order);
  const townCoords = getTownCoords(town);
  if (townCoords) {
    return { ...townCoords, precision: "TOWN", town };
  }

  const areaCoords = getAreaCoords(order?.area);
  if (areaCoords) {
    return { ...areaCoords, precision: "AREA", town: null };
  }

  return null;
}

// Where an order sits on a map that is showing towns rather than doorsteps.
//
// This is resolveDestination with its first tier deliberately removed. The ETA
// wants the most precise point it can get and takes the customer's own pin
// whenever one exists; the driver app's home map wants the opposite — one
// consistent point per town, so a driver can read "four in Jounieh, two in
// Zahle" off the map at a glance. Mixing the two tiers there would scatter the
// orders that happen to carry a pin away from the town marker their neighbours
// share, and the count stops being readable.
//
// Nothing here promises a doorstep, so the app never routes to it. It is a
// picture of the run, and the address on the card is what the driver drives to.
function resolveCityCentre(order) {
  const town = resolveOrderTown(order);
  const townCoords = getTownCoords(town);
  if (townCoords) {
    return { ...townCoords, precision: "TOWN", town };
  }

  const areaCoords = getAreaCoords(order?.area);
  if (areaCoords) {
    return { ...areaCoords, precision: "AREA", town: null };
  }

  return null;
}

module.exports = {
  AREA_CENTROIDS,
  resolveOrderTown,
  haversineKm,
  getTownCoords,
  getAreaCoords,
  resolveDestination,
  resolveCityCentre,
  nearestTown,
};
