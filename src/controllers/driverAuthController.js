const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Driver authentication controller.
// - POST /api/drivers/signup: creates a driver with email + phone + password and returns a JWT
// - POST /api/drivers/login: validates phone + password credentials and returns a JWT
// - GET  /api/drivers/me: returns the authenticated driver's public profile (no password_hash)
// - POST /api/drivers/me/password: allows a logged-in driver to change their password (added to fix
//   the broken change-password feature — previously the UI showed a fake success without calling
//   any API, and no backend endpoint existed, so the password was never actually updated)

const {
  getDriverByPhone,
  getDriverByEmail,
  createDriver,
  getPublicDriverById,
  updateDriverPassword,
} = require("../services/driverService");

function signDriverToken(driverId) {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("Server misconfigured: missing JWT_SECRET");
  }

  return jwt.sign(
    {
      sub: String(driverId),
      type: "driver",
    },
    secret,
    { expiresIn: "30d" }
  );
}

// Added email as a required signup field.
// Validates format here so we return a clear 400 before touching the DB,
// rather than letting Postgres throw a constraint error the client can't parse.
async function signupDriver(req, res) {
  try {
    const { full_name, email, phone, password } = req.body || {};

    if (!full_name || !email || !phone || !password) {
      return res
        .status(400)
        .json({ error: "full_name, email, phone, and password are required" });
    }

    // Regex catches obvious typos (missing @, missing domain) before the DB unique check.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const existing = await getDriverByPhone(phone);
    if (existing) {
      return res
        .status(409)
        .json({ error: "A driver with this phone already exists" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const created = await createDriver({
      full_name,
      email,
      phone,
      password_hash,
      status: "AVAILABLE",
    });

    const token = signDriverToken(created.id);

    return res.status(201).json({
      token,
      driver: created,
    });
  } catch (error) {
    console.error("Error signing up driver:", error);
    const msg =
      (error && error.message === "Server misconfigured: missing JWT_SECRET")
        ? error.message
        : "Failed to sign up";
    return res.status(500).json({ error: msg });
  }
}

// Login now uses email + password. Phone is no longer accepted here
// (signup still collects phone for delivery/contact purposes).
async function loginDriver(req, res) {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const driver = await getDriverByEmail(email);
    if (!driver) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, driver.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signDriverToken(driver.id);

    // email included so the profile screen can display it after login
    // without needing a separate GET /me call.
    return res.json({
      token,
      driver: {
        id: driver.id,
        full_name: driver.full_name,
        email: driver.email,
        phone: driver.phone,
        status: driver.status,
        created_at: driver.created_at,
      },
    });
  } catch (error) {
    console.error("Error logging in driver:", error);
    const msg =
      (error && error.message === "Server misconfigured: missing JWT_SECRET")
        ? error.message
        : "Failed to log in";
    return res.status(500).json({ error: msg });
  }
}

async function getMe(req, res) {
  try {
    const driverId = req.driverId;
    const driver = await getPublicDriverById(driverId);

    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    return res.json(driver);
  } catch (error) {
    console.error("Error fetching driver profile:", error);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
}

// Added to fix the change-password feature.
// Root cause of the bug: the Flutter UI had a TODO stub that showed a fake "Password updated"
// success message after an 800 ms delay without ever calling the backend, and this endpoint
// did not exist at all, so the password in the database was never changed.
//
// Fix — this handler does four things in order:
//   1. Validates that both current_password and new_password were sent in the request body.
//   2. Looks up the driver's full database row (which includes the stored bcrypt hash) using
//      their driver ID from the JWT token that requireDriverAuth already verified.
//   3. Uses bcrypt.compare() to check that current_password matches the stored hash — this
//      prevents any logged-in driver from changing to a new password without knowing the old one.
//   4. Hashes the new password with bcrypt (salt rounds = 10, same as signup) and saves it to
//      the database via updateDriverPassword(), so future logins use the new hash correctly.
async function changePassword(req, res) {
  try {
    const { current_password, new_password } = req.body || {};

    // Step 1: reject the request early if either field is missing.
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "current_password and new_password are required" });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: "new_password must be at least 6 characters" });
    }

    // Step 2: get the driver's public profile first (to retrieve their email),
    // then re-fetch the full row so we have the password_hash for comparison.
    // getPublicDriverById intentionally omits password_hash for safety, so we need
    // a second query via getDriverByEmail to get the full row.
    const driver = await getPublicDriverById(req.driverId);
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Step 3: verify the current password against the stored bcrypt hash.
    // bcrypt.compare() is safe even if the hash is from a different salt round
    // because the salt is embedded inside the hash string itself.
    const fullDriver = await getDriverByEmail(driver.email);
    const ok = await bcrypt.compare(current_password, fullDriver.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Step 4: hash the new password and persist it.
    // Using the same salt rounds (10) as signup so the stored format stays consistent.
    const newHash = await bcrypt.hash(new_password, 10);
    await updateDriverPassword(req.driverId, newHash);

    return res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error changing password:", error);
    return res.status(500).json({ error: "Failed to change password" });
  }
}

module.exports = {
  signupDriver,
  loginDriver,
  getMe,
  changePassword,
};
