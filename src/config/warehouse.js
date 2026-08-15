// warehouse.js
//
// Where a delivery run starts and ends.
//
// The driver loads the van at the warehouse and comes back to it, so that is
// the fixed point every route is measured from: "shortest route" has no meaning
// without one, and the same set of stops orders differently depending on which
// end of the country you set off from.
//
// The default is the Amchit warehouse. It is overridable by environment so a
// second warehouse — or a move down the road — needs a variable rather than a
// deploy of this file, and so a staging server can point somewhere harmless.
//
// The coordinates are the town centre from src/data/town-coords.json rather
// than the loading door. Route ordering compares stops that are kilometres
// apart, so the few hundred metres between the town centre and the door never
// changes which stop comes first.

const DEFAULT_WAREHOUSE = {
  name: "Amchit",
  latitude: 34.15,
  longitude: 35.65,
};

function parseCoordinate(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// The point runs start from, as { name, latitude, longitude }.
//
// WAREHOUSE_LAT and WAREHOUSE_LNG are read together: half an override is a
// misconfiguration, not a request to move the warehouse onto a meridian, so
// unless both parse the default stands and the reason is logged once.
let warned = false;

function getWarehouse() {
  const latitude = parseCoordinate(process.env.WAREHOUSE_LAT);
  const longitude = parseCoordinate(process.env.WAREHOUSE_LNG);

  if (latitude != null && longitude != null) {
    return {
      name: (process.env.WAREHOUSE_NAME || "").trim() || "Warehouse",
      latitude,
      longitude,
    };
  }

  if ((process.env.WAREHOUSE_LAT || process.env.WAREHOUSE_LNG) && !warned) {
    warned = true;
    console.warn(
      "[Warehouse] WAREHOUSE_LAT and WAREHOUSE_LNG must both be set and numeric; " +
        `falling back to ${DEFAULT_WAREHOUSE.name}.`
    );
  }

  return { ...DEFAULT_WAREHOUSE };
}

module.exports = { getWarehouse, DEFAULT_WAREHOUSE };
