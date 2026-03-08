const pool = require("../config/db");

async function getAllOrders(req, res) {
  try {
    const result = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch orders" });
  }
}

module.exports = {
  getAllOrders,
};