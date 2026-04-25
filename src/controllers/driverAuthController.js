const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Driver authentication controller.
// - POST /api/drivers/signup: creates a driver with email + phone + password and returns a JWT
// - POST /api/drivers/login: validates phone + password credentials and returns a JWT
// - GET  /api/drivers/me: returns the authenticated driver's public profile (no password_hash)

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

async function changePassword(req, res) {
  try {
    const { current_password, new_password } = req.body || {};

    if (!current_password || !new_password) {
      return res.status(400).json({ error: "current_password and new_password are required" });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: "new_password must be at least 6 characters" });
    }

    const driver = await getPublicDriverById(req.driverId);
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Fetch the full row (including password_hash) to verify current password.
    const fullDriver = await getDriverByEmail(driver.email);
    const ok = await bcrypt.compare(current_password, fullDriver.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

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
