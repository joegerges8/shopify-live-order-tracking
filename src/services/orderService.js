const pool = require("../config/db");

// Returns every order for a specific store, newest first.
async function getAllOrders(storeId) {
  const result = await pool.query(
    `SELECT * FROM orders WHERE store_id = $1 ORDER BY created_at DESC`,
    [storeId]
  );
  return result.rows;
}

// Returns a single order by primary key, scoped to the store.
async function getOrderById(orderId, storeId) {
  const result = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND store_id = $2 LIMIT 1`,
    [orderId, storeId]
  );
  return result.rows[0];
}

async function assignDriverToOrder(orderId, driverId, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET assigned_driver_id = $1, order_status = 'ASSIGNED'
     WHERE id = $2 AND store_id = $3
     RETURNING *`,
    [driverId, orderId, storeId]
  );
  return result.rows[0];
}

async function unassignDriverFromOrder(orderId, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET assigned_driver_id = NULL, order_status = 'PENDING'
     WHERE id = $1 AND store_id = $2
     RETURNING *`,
    [orderId, storeId]
  );
  return result.rows[0];
}

async function updateOrderStatus(orderId, status, storeId) {
  const query =
    status === "DELIVERED"
      ? `UPDATE orders SET order_status = $1, delivered_at = NOW(), financial_status = 'paid'
         WHERE id = $2 AND store_id = $3 RETURNING *`
      : `UPDATE orders SET order_status = $1
         WHERE id = $2 AND store_id = $3 RETURNING *`;

  const result = await pool.query(query, [status, orderId, storeId]);
  return result.rows[0];
}

// Driver-scoped updates — drivers are global, no store filter needed here.
async function updateDriverOrderStatus(orderId, driverId, status) {
  const query =
    status === "DELIVERED"
      ? `UPDATE orders
         SET order_status = $1, delivered_at = NOW(), financial_status = 'paid'
         WHERE id = $2 AND assigned_driver_id = $3
         RETURNING *`
      : `UPDATE orders
         SET order_status = $1
         WHERE id = $2 AND assigned_driver_id = $3
         RETURNING *`;

  const result = await pool.query(query, [status, orderId, driverId]);
  return result.rows[0];
}

async function getOrdersByDriverId(driverId) {
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE assigned_driver_id = $1
       AND order_status NOT IN ('DELIVERED', 'CANCELLED')
     ORDER BY created_at DESC`,
    [driverId]
  );
  return result.rows;
}

async function getCompletedOrdersByDriverId(driverId) {
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE assigned_driver_id = $1
       AND order_status = 'DELIVERED'
     ORDER BY COALESCE(delivered_at, created_at) DESC
     LIMIT 100`,
    [driverId]
  );
  return result.rows;
}

async function createLocationUpdate({ order_id, driver_id, latitude, longitude }) {
  const result = await pool.query(
    `INSERT INTO location_updates (order_id, driver_id, latitude, longitude)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [order_id, driver_id, latitude, longitude]
  );
  return result.rows[0];
}

// Public tracking lookup — token is globally unique, no store filter needed.
async function getOrderByTrackingToken(token) {
  const result = await pool.query(
    `SELECT
       o.id, o.order_number, o.order_status,
       o.customer_first_name, o.customer_last_name,
       o.shipping_address, o.city,
       o.customer_latitude, o.customer_longitude,
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
       WHERE order_id = o.id AND driver_id = o.assigned_driver_id
       ORDER BY created_at DESC LIMIT 1
     ) lu ON TRUE
     WHERE o.tracking_token = $1
     LIMIT 1`,
    [token]
  );
  return result.rows[0];
}

async function updateCustomerLocation(orderId, lat, lng, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET customer_latitude = $1, customer_longitude = $2
     WHERE id = $3 AND store_id = $4
     RETURNING *`,
    [lat, lng, orderId, storeId]
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
