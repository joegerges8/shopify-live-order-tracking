// orderService.js
//
// Data-access layer for the orders table in the PostgreSQL database.
// All SQL queries go here — controllers call these functions instead of
// writing SQL directly, which keeps the query logic in one place and makes
// it easier to test or swap the database in future.
//
// Uses a connection pool (pg Pool) so the app can handle many concurrent
// requests without opening a new database connection for every query.

const pool = require("../config/db");

// Returns every order in the system, newest first.
// Used by the dispatcher/admin panel to see all orders.
async function getAllOrders() {
  const result = await pool.query(`
    SELECT *
    FROM orders
    ORDER BY created_at DESC
  `);

  return result.rows;
}

// Returns a single order by its primary key.
// Used for ownership checks before allowing status updates or location posts.
async function getOrderById(orderId) {
  const result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE id = $1
    LIMIT 1
    `,
    [orderId]
  );

  return result.rows[0]; // undefined if not found — callers check for this.
}

// Assigns a driver to an order and sets status to ASSIGNED.
// Called by the dispatcher when they choose which driver handles an order.
async function assignDriverToOrder(orderId, driverId) {
  const result = await pool.query(
    `
    UPDATE orders
    SET assigned_driver_id = $1,
        order_status = 'ASSIGNED'
    WHERE id = $2
    RETURNING *
    `,
    [driverId, orderId]
  );

  return result.rows[0];
}

// Removes the driver assignment and resets the order to PENDING.
// Called by the dispatcher if a driver needs to be swapped out.
async function unassignDriverFromOrder(orderId) {
  const result = await pool.query(
    `
    UPDATE orders
    SET assigned_driver_id = NULL,
        order_status = 'PENDING'
    WHERE id = $1
    RETURNING *
    `,
    [orderId]
  );

  return result.rows[0];
}

// Updates the status of an order (e.g. PICKED_UP → DELIVERED).
// The CASE expression automatically stamps the delivered_at timestamp
// the moment the status changes to 'DELIVERED', so we have an accurate
// record of when each delivery was completed. For any other status change
// delivered_at is left unchanged (it keeps its previous value or stays NULL).
async function updateOrderStatus(orderId, status) {
  // COD (Cash on Delivery) payment logic:
  // When the driver marks an order as DELIVERED, it means they have physically
  // collected the cash from the customer at the door. At that exact moment,
  // the order transitions from financially "pending" (unpaid) to "paid".
  // We therefore update financial_status = 'paid' in the same SQL statement
  // as the delivery confirmation — this keeps the two state changes atomic
  // (both happen together or neither does), so the database is never in an
  // inconsistent state where an order is DELIVERED but still shows as unpaid.
  //
  // For any other status change (e.g. PICKED_UP), we only update order_status
  // and leave financial_status untouched.
  const query =
    status === "DELIVERED"
      ? `UPDATE orders SET order_status = $1, delivered_at = NOW(), financial_status = 'paid' WHERE id = $2 RETURNING *`
      : `UPDATE orders SET order_status = $1 WHERE id = $2 RETURNING *`;

  const result = await pool.query(query, [status, orderId]);
  return result.rows[0];
}

// Same status update as updateOrderStatus(), but scoped to the authenticated
// driver so the common driver-app action is a single database round trip.
async function updateDriverOrderStatus(orderId, driverId, status) {
  const query =
    status === "DELIVERED"
      ? `
        UPDATE orders
        SET order_status = $1,
            delivered_at = NOW(),
            financial_status = 'paid'
        WHERE id = $2
          AND assigned_driver_id = $3
        RETURNING *
      `
      : `
        UPDATE orders
        SET order_status = $1
        WHERE id = $2
          AND assigned_driver_id = $3
        RETURNING *
      `;

  const result = await pool.query(query, [status, orderId, driverId]);
  return result.rows[0];
}

// Returns all orders that are still active (not yet delivered or cancelled)
// for a given driver. This powers the All / Pending / Active tabs in the
// driver app. Excluding DELIVERED and CANCELLED orders keeps the list clean —
// completed orders are fetched separately by getCompletedOrdersByDriverId.
async function getOrdersByDriverId(driverId) {
  const result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE assigned_driver_id = $1
      AND order_status NOT IN ('DELIVERED', 'CANCELLED')
    ORDER BY created_at DESC
    `,
    [driverId]
  );

  return result.rows;
}

// Returns all orders that have been successfully delivered by this driver,
// ordered by the most recently delivered first.
//
// COALESCE(delivered_at, created_at) is used for ordering so that orders
// delivered before the delivered_at column was added to the database (via the
// migration: ALTER TABLE orders ADD COLUMN delivered_at TIMESTAMP) still sort
// sensibly by their creation date instead of failing.
//
// LIMIT 100 prevents the query from returning an unbounded result set if a
// driver has been working for a very long time.
async function getCompletedOrdersByDriverId(driverId) {
  const result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE assigned_driver_id = $1
      AND order_status = 'DELIVERED'
    ORDER BY COALESCE(delivered_at, created_at) DESC
    LIMIT 100
    `,
    [driverId]
  );

  return result.rows;
}

// Inserts a GPS coordinate ping into the location_updates table.
// Called by the driver app periodically while a delivery is in progress so
// the customer's live-tracking page can show the driver's current position.
async function createLocationUpdate({ order_id, driver_id, latitude, longitude }) {
  const result = await pool.query(
    `
    INSERT INTO location_updates (order_id, driver_id, latitude, longitude)
    VALUES ($1, $2, $3, $4)
    RETURNING *
    `,
    [order_id, driver_id, latitude, longitude]
  );

  return result.rows[0];
}

// Returns order info + latest driver GPS ping for the customer tracking page.
// The token acts as a bearer credential — no login required.
// Uses a LATERAL join to get the single most recent location_updates row
// without a separate query round-trip.
async function getOrderByTrackingToken(token) {
  const result = await pool.query(
    `
    SELECT
      o.id,
      o.order_number,
      o.order_status,
      o.customer_first_name,
      o.customer_last_name,
      o.shipping_address,
      o.city,
      o.customer_latitude,
      o.customer_longitude,
      o.delivered_at,
      d.full_name  AS driver_name,
      d.phone      AS driver_phone,
      lu.latitude  AS driver_lat,
      lu.longitude AS driver_lng,
      lu.created_at AS location_updated_at
    FROM orders o
    LEFT JOIN drivers d ON d.id = o.assigned_driver_id
    LEFT JOIN LATERAL (
      SELECT latitude, longitude, created_at
      FROM location_updates
      WHERE order_id = o.id
        AND driver_id = o.assigned_driver_id
      ORDER BY created_at DESC
      LIMIT 1
    ) lu ON TRUE
    WHERE o.tracking_token = $1
    LIMIT 1
    `,
    [token]
  );

  return result.rows[0];
}

async function updateCustomerLocation(orderId, lat, lng) {
  const result = await pool.query(
    `UPDATE orders SET customer_latitude = $1, customer_longitude = $2 WHERE id = $3 RETURNING *`,
    [lat, lng, orderId]
  );
  return result.rows[0];
}

module.exports = {
  getAllOrders,
  getOrderById,
  assignDriverToOrder,
  unassignDriverFromOrder,
  updateOrderStatus,
  updateDriverOrderStatus,
  getOrdersByDriverId,
  getCompletedOrdersByDriverId,
  createLocationUpdate,
  getOrderByTrackingToken,
  updateCustomerLocation,
};
