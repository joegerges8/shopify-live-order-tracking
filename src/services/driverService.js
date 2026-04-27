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

async function deleteDriverById(driverId) {
  const result = await pool.query(
    `DELETE FROM drivers WHERE id = $1 RETURNING id`,
    [driverId]
  );
  return result.rows[0];
}

module.exports = {
  getAllDrivers,
  getDriverByPhone,
  getDriverByEmail,
  createDriver,
  getPublicDriverById,
  updateDriverPassword,
  deleteDriverById,
};