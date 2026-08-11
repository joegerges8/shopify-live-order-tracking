const bcrypt = require("bcryptjs");
const {
  LIVE_PING_WINDOW_SECONDS,
  getAllDrivers,
  getDriverLiveLocations,
  getDriverByPhone,
  createDriver,
  deleteDriverById,
} = require("../services/driverService");
const { reverseGeocodeCity } = require("../services/mapsService");

async function getDrivers(req, res) {
  try {
    const drivers = await getAllDrivers();
    return res.json(drivers);
  } catch (error) {
    console.error("Error fetching drivers:", error);
    return res.status(500).json({ error: "Failed to fetch drivers" });
  }
}

// The more recent of a driver's two possible positions, or null if neither
// exists. NUMERIC and EXTRACT both come back from pg as strings, and a map
// cannot plot a string, so the conversion happens once here.
function pickFreshestFix(row) {
  const candidates = [
    {
      latitude: row.self_lat,
      longitude: row.self_lng,
      updatedAt: row.self_updated_at,
      ageSeconds: row.self_age_seconds,
    },
    {
      latitude: row.ping_lat,
      longitude: row.ping_lng,
      updatedAt: row.ping_updated_at,
      ageSeconds: row.ping_age_seconds,
    },
  ]
    .filter(
      (fix) =>
        fix.latitude != null && fix.longitude != null && fix.ageSeconds != null
    )
    .map((fix) => ({
      latitude: Number(fix.latitude),
      longitude: Number(fix.longitude),
      updatedAt: fix.updatedAt,
      ageSeconds: Number(fix.ageSeconds),
    }));

  if (!candidates.length) return null;

  return candidates.reduce((freshest, fix) =>
    fix.ageSeconds < freshest.ageSeconds ? fix : freshest
  );
}

// GET /api/drivers/locations — the live map's data.
//
// Returns one entry per driver whether or not they are moving, so the panel
// beside the map can list the whole fleet and say plainly who is idle. The
// numeric columns come back from pg as strings (NUMERIC and EXTRACT both do),
// and a map cannot plot a string, so they are converted here rather than in
// three places on the client.
async function getDriverLocations(req, res) {
  try {
    const rows = await getDriverLiveLocations(req.storeId);

    // Each driver's position comes from whichever of the two sources spoke
    // most recently — their own fix, or the newest ping on one of this store's
    // orders. In practice the driver's own is fresher whenever the app is
    // running; the per-order ping is what still answers for a driver on an app
    // build that predates the driver-level endpoint.
    const fixes = rows.map(pickFreshestFix);

    // Where each driver actually is, in words. The order carries the town it
    // is going to, which is not the same thing and reads as a plain
    // contradiction next to a pin sitting somewhere else entirely.
    //
    // Resolved in parallel and cached by rough coordinate inside mapsService,
    // so a fleet standing still costs nothing after the first poll. Every
    // lookup already fails soft to null, so no guard is needed here.
    const towns = await Promise.all(
      fixes.map((fix) => (fix ? reverseGeocodeCity(fix.latitude, fix.longitude) : null))
    );

    const drivers = rows.map((row, index) => {
      const fix = fixes[index];

      return {
        id: row.id,
        full_name: row.full_name,
        phone: row.phone,
        active_orders: row.active_orders ?? 0,
        // "Online" is about the GPS, not about being logged in: it means a fix
        // arrived recently enough that the pin can be trusted as where the
        // driver is now. With the app posting while it runs, this is in
        // practice "their app is open".
        online: fix !== null && fix.ageSeconds <= LIVE_PING_WINDOW_SECONDS,
        location: fix
          ? {
              latitude: fix.latitude,
              longitude: fix.longitude,
              updated_at: fix.updatedAt,
              age_seconds: Math.round(fix.ageSeconds),
              // The town the driver is in. null when reverse geocoding is
              // unconfigured or could not name the spot — the map then shows
              // the pin without a caption rather than inventing one.
              city: towns[index] || null,
            }
          : null,
        // The delivery they are on now — see getDriverLiveLocations for why
        // this is looked up fresh rather than read off the last ping.
        order: row.order_id
          ? {
              id: row.order_id,
              order_number: row.order_number,
              order_status: row.order_status,
              city: row.city,
              area: row.area,
              customer_name:
                [row.customer_first_name, row.customer_last_name]
                  .filter(Boolean)
                  .join(" ") || null,
              tracking_token: row.tracking_token,
            }
          : null,
      };
    });

    return res.json({
      live_window_seconds: LIVE_PING_WINDOW_SECONDS,
      drivers,
    });
  } catch (error) {
    console.error("Error fetching driver locations:", error);
    return res.status(500).json({ error: "Failed to fetch driver locations" });
  }
}

async function createNewDriver(req, res) {
  try {
    const { full_name, phone, password, status } = req.body;

    if (!full_name || !phone || !password) {
      return res.status(400).json({
        error: "full_name, phone, and password are required",
      });
    }

    const existingDriver = await getDriverByPhone(phone);

    if (existingDriver) {
      return res.status(409).json({
        error: "A driver with this phone already exists",
      });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const newDriver = await createDriver({
      full_name,
      phone,
      password_hash,
      status: status || "AVAILABLE",
    });

    return res.status(201).json(newDriver);
  } catch (error) {
    console.error("Error creating driver:", error);
    return res.status(500).json({ error: "Failed to create driver" });
  }
}

async function deleteDriver(req, res) {
  try {
    const driverId = parseInt(req.params.id, 10);
    if (!driverId) {
      return res.status(400).json({ error: "Invalid driver ID" });
    }
    const deleted = await deleteDriverById(driverId);
    if (!deleted) {
      return res.status(404).json({ error: "Driver not found" });
    }
    return res.json({ message: "Driver deleted", id: deleted.id });
  } catch (error) {
    console.error("Error deleting driver:", error);
    return res.status(500).json({ error: "Failed to delete driver" });
  }
}

module.exports = {
  getDrivers,
  getDriverLocations,
  createNewDriver,
  deleteDriver,
};