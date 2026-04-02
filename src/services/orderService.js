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

module.exports = {
  getAllOrders,
  getOrderById,
  assignDriverToOrder,
  updateOrderStatus
};