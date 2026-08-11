const pool = require("../config/db");

async function getAllDrivers() {
  const result = await pool.query(`
    SELECT id, full_name, email, phone, status, created_at
    FROM drivers
    ORDER BY created_at DESC
  `);

  return result.rows;
}

async function getDriverByPhone(phone) {
  const result = await pool.query(
    `
    SELECT *
    FROM drivers
    WHERE phone = $1
    LIMIT 1
    `,
    [phone]
  );

  return result.rows[0];
}

// Used by loginDriver — looks up the driver by email so the login form
// can use email + password instead of phone + password.
async function getDriverByEmail(email) {
  const result = await pool.query(
    `
    SELECT *
    FROM drivers
    WHERE email = $1
    LIMIT 1
    `,
    [email]
  );

  return result.rows[0];
}

// email is optional at the DB level (existing rows have NULL) but required by the
// signup controller. Passing null explicitly avoids the column being omitted entirely.
async function createDriver({ full_name, email, phone, password_hash, status = "AVAILABLE" }) {
  const result = await pool.query(
    `
    INSERT INTO drivers (full_name, email, phone, password_hash, status)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, full_name, email, phone, status, created_at
    `,
    [full_name, email || null, phone, password_hash, status]
  );

  return result.rows[0];
}

// Used by GET /api/drivers/me — returns a safe subset of fields, never password_hash.
// email is included so the profile screen can display it after a refresh.
async function getPublicDriverById(driverId) {
  const result = await pool.query(
    `
    SELECT id, full_name, email, phone, status, created_at
    FROM drivers
    WHERE id = $1
    LIMIT 1
    `,
    [driverId]
  );

  return result.rows[0];
}

// Added to support the changePassword controller.
// Overwrites the password_hash column for the given driver with a new bcrypt hash.
// The caller (changePassword in driverAuthController) is responsible for verifying
// the current password and hashing the new one before calling this function.
async function updateDriverPassword(driverId, newPasswordHash) {
  await pool.query(
    `UPDATE drivers SET password_hash = $1 WHERE id = $2`,
    [newPasswordHash, driverId]
  );
}

// How long a GPS ping keeps counting as live.
//
// The driver app posts a fix roughly every 15 seconds while a delivery is
// running, so anything much older than a couple of minutes means the driver
// finished the run, closed the app or lost signal. The dispatcher map shows
// those drivers as offline rather than leaving a stale pin sitting on a road
// they left an hour ago.
const LIVE_PING_WINDOW_SECONDS = 120;

// Statuses that mean the order is off the driver's hands. Kept here because
// two queries below have to agree about what "still carrying it" means.
const FINISHED_ORDER_STATUSES = ["DELIVERED", "RETURNED", "CANCELLED", "FULFILLED"];

// Every driver's most recent position, for the dispatcher's live map.
//
// Location pings are recorded per order, not per driver, so "where is this
// driver" means "the newest ping they filed on any of this store's orders".
// The store filter is not cosmetic: drivers are shared across stores, and
// without it one merchant's dashboard would show driver movement — and the
// order behind it — belonging to another merchant's deliveries.
//
// The order reported alongside the position is deliberately NOT the one that
// last ping was filed against. That order may since have been delivered or
// returned, and reading it back left the map insisting a driver was still on a
// job they had finished — a pin labelled "Returned" for as long as the last
// ping stayed on file. What a dispatcher is asking is "what is this driver
// carrying now", so the answer is looked up fresh from the orders table: the
// pinged order while it is still live, otherwise their newest open one,
// otherwise nothing at all.
//
// Drivers with no ping at all are still returned, with a null location. They
// are the ones sitting idle, and a dispatcher wants to see that they exist
// just as much as they want to see who is moving.
async function getDriverLiveLocations(storeId) {
  const result = await pool.query(
    `SELECT
       d.id,
       d.full_name,
       d.phone,
       lu.latitude,
       lu.longitude,
       lu.created_at AS location_updated_at,
       -- Measured by Postgres for the same reason the tracking query does it:
       -- location_updates.created_at carries no timezone, so comparing it to a
       -- clock in Node would depend on both processes agreeing about which one
       -- they are in.
       EXTRACT(EPOCH FROM (NOW() - lu.created_at)) AS location_age_seconds,
       o.id            AS order_id,
       o.order_number,
       o.order_status,
       o.city,
       o.area,
       o.customer_first_name,
       o.customer_last_name,
       o.tracking_token,
       act.active_orders
     FROM drivers d
     LEFT JOIN LATERAL (
       SELECT l.latitude, l.longitude, l.created_at, l.order_id
       FROM location_updates l
       JOIN orders lo ON lo.id = l.order_id
       WHERE l.driver_id = d.id AND lo.store_id = $1
       ORDER BY l.created_at DESC
       LIMIT 1
     ) lu ON TRUE
     -- What the driver is carrying now, which is a different question from
     -- which order the last ping was filed against. The order being pinged
     -- wins while it is still open, so a driver mid-delivery is labelled with
     -- the delivery they are actually on; a finished one falls through to
     -- their next open order, and a driver with none at all gets no order
     -- rather than the ghost of their last one.
     LEFT JOIN LATERAL (
       SELECT ao.id, ao.order_number, ao.order_status, ao.city, ao.area,
              ao.customer_first_name, ao.customer_last_name, ao.tracking_token
       FROM orders ao
       WHERE ao.assigned_driver_id = d.id
         AND ao.store_id = $1
         AND ao.order_status <> ALL ($2::text[])
       ORDER BY COALESCE(ao.id = lu.order_id, FALSE) DESC, ao.created_at DESC
       LIMIT 1
     ) o ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS active_orders
       FROM orders ao
       WHERE ao.assigned_driver_id = d.id
         AND ao.store_id = $1
         AND ao.order_status <> ALL ($2::text[])
     ) act ON TRUE
     -- Whoever is moving right now sorts to the top, idle drivers to the
     -- bottom: the list beside the map reads in the order a dispatcher cares.
     ORDER BY (lu.created_at IS NULL), lu.created_at DESC, d.full_name`,
    [storeId, FINISHED_ORDER_STATUSES]
  );

  return result.rows;
}

async function deleteDriverById(driverId) {
  const result = await pool.query(
    `DELETE FROM drivers WHERE id = $1 RETURNING id`,
    [driverId]
  );
  return result.rows[0];
}

module.exports = {
  LIVE_PING_WINDOW_SECONDS,
  getAllDrivers,
  getDriverLiveLocations,
  getDriverByPhone,
  getDriverByEmail,
  createDriver,
  getPublicDriverById,
  updateDriverPassword,
  deleteDriverById,
};