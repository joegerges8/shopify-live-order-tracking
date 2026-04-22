const pool = require("../config/db");

async function getAllOrders() {
  const result = await pool.query(`
    SELECT *
    FROM orders
    ORDER BY created_at DESC
  `);

  return result.rows;
}

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

  return result.rows[0];
}

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

async function updateOrderStatus(orderId, status) {
  const result = await pool.query(
    `
    UPDATE orders
    SET order_status = $1
    WHERE id = $2
    RETURNING *
    `,
    [status, orderId]
  );

  return result.rows[0];
}

// Added in this change:
// Driver app endpoints need to fetch only the orders assigned to the
// authenticated driver.
async function getOrdersByDriverId(driverId) {
  const result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE assigned_driver_id = $1
    ORDER BY created_at DESC
    `,
    [driverId]
  );

  return result.rows;
}

// Added in this change:
// Stores a driver's live GPS ping for an order in the location_updates table.
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

module.exports = {
  getAllOrders,
  getOrderById,
  assignDriverToOrder,
  unassignDriverFromOrder,
  updateOrderStatus,
  getOrdersByDriverId,
  createLocationUpdate,
};