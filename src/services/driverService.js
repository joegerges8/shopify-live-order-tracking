const pool = require("../config/db");

async function getAllDrivers() {
  const result = await pool.query(`
    SELECT id, full_name, phone, status, created_at
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

async function createDriver({ full_name, phone, password_hash, status = "AVAILABLE" }) {
  const result = await pool.query(
    `
    INSERT INTO drivers (full_name, phone, password_hash, status)
    VALUES ($1, $2, $3, $4)
    RETURNING id, full_name, phone, status, created_at
    `,
    [full_name, phone, password_hash, status]
  );

  return result.rows[0];
}

// Added in this change:
// Used by /api/drivers/me to return a safe subset of driver fields
// without returning password_hash.
async function getPublicDriverById(driverId) {
  const result = await pool.query(
    `
    SELECT id, full_name, phone, status, created_at
    FROM drivers
    WHERE id = $1
    LIMIT 1
    `,
    [driverId]
  );

  return result.rows[0];
}

module.exports = {
  getAllDrivers,
  getDriverByPhone,
  createDriver,
  getPublicDriverById,
};