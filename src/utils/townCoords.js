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
const { resolveTown } = require("./areaLookup");

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

  const town = resolveTown(order?.city);
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
  haversineKm,
  getTownCoords,
  getAreaCoords,
  resolveDestination,
};
