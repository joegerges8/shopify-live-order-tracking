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

// How long a GPS ping keeps counting as live — and so, how quickly a driver
// who has closed the app leaves the dispatcher's map.
//
// The driver app posts a fix roughly every 15 seconds while it is running, so
// this is four missed pings in a row. That is short enough that swiping the
// app away shows up on the map inside a minute, and long enough that a tunnel,
// an underground car park or a moment of bad signal does not flicker a working
// driver off the screen and back. Raise it if drivers on poor coverage start
// disappearing mid-delivery.
const LIVE_PING_WINDOW_SECONDS = 60;

// Statuses that mean the order is off the driver's hands. Kept here because
// two queries below have to agree about what "still carrying it" means.
const FINISHED_ORDER_STATUSES = ["DELIVERED", "RETURNED", "CANCELLED", "FULFILLED"];

// Records where a driver is, independently of any delivery.
//
// The driver app posts this on its own timer for as long as it is running, so
// the dispatcher can see who is out there before deciding who gets the next
// order. Only the newest fix is kept — the map asks "where are they now", and
// the trail that matters is the per-order one in location_updates, which this
// deliberately does not touch. The customer's tracking page reads only that
// table and is unaffected by anything here.
async function updateDriverLocation(driverId, latitude, longitude) {
  const result = await pool.query(
    `UPDATE drivers
     SET last_latitude = $1, last_longitude = $2, last_location_at = NOW()
     WHERE id = $3
     RETURNING id, last_latitude, last_longitude, last_location_at`,
    [latitude, longitude, driverId]
  );
  return result.rows[0];
}

// Every driver's most recent position, for the dispatcher's live map.
//
// Two things can say where a driver is, and the fresher one wins:
//
//   • drivers.last_* — the driver's own position, posted for as long as their
//     app is running whether or not they are carrying anything. This is what
//     puts an idle driver on the map, which is the whole point of a dispatch
//     map: the driver you want for a new order is the one who is free.
//   • location_updates — the newest ping filed against one of THIS store's
//     orders. Older app builds post only these, so a driver who has not
//     updated still appears while they are mid-delivery.
//
// The store filter on the second is not cosmetic: it keeps one merchant's
// dashboard from naming the order another merchant's delivery belongs to. The
// driver's own position carries no order with it and so is not store-scoped —
// drivers are shared across every store, and each store's dashboard already
// lists all of them.
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
       -- The driver's own fix, and the newest one filed against this store's
       -- orders. Both are returned and the controller takes the fresher; doing
       -- it there rather than in a CASE per column keeps this readable.
       d.last_latitude    AS self_lat,
       d.last_longitude   AS self_lng,
       d.last_location_at AS self_updated_at,
       lu.latitude        AS ping_lat,
       lu.longitude       AS ping_lng,
       lu.created_at      AS ping_updated_at,
       -- Ages measured by Postgres for the same reason the tracking query does
       -- it: location_updates.created_at carries no timezone, so comparing it
       -- to a clock in Node would depend on both processes agreeing about
       -- which one they are in.
       EXTRACT(EPOCH FROM (NOW() - d.last_location_at)) AS self_age_seconds,
       EXTRACT(EPOCH FROM (NOW() - lu.created_at))      AS ping_age_seconds,
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
     -- Freshest fix first, from whichever source, and drivers nobody has heard
     -- from at all last: the list beside the map reads in the order a
     -- dispatcher cares about.
     ORDER BY LEAST(
                COALESCE(EXTRACT(EPOCH FROM (NOW() - d.last_location_at)), 1e12),
                COALESCE(EXTRACT(EPOCH FROM (NOW() - lu.created_at)), 1e12)
              ) ASC,
              d.full_name`,
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
  updateDriverLocation,
  getDriverByPhone,
  getDriverByEmail,
  createDriver,
  getPublicDriverById,
  updateDriverPassword,
  deleteDriverById,
};