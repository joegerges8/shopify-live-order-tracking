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
const { phonesMatch } = require("../utils/driverPhone");

const MIN_PASSWORD_LENGTH = 6;

// How many times one email may be tried on the forgot-password endpoint before
// it is told to wait. The check behind that endpoint is email + phone, and a
// phone number is a short thing to guess, so the endpoint cannot be left open
// to unlimited tries. Five in a quarter of an hour is plenty for a driver who
// mistyped their number once or twice, and useless for a script.
//
// Kept in memory on purpose: the backend runs as a single Railway instance, a
// restart resetting the counters costs nothing, and a table for this would be
// more machinery than the problem deserves.
const RESET_ATTEMPT_LIMIT = 5;
const RESET_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const resetAttempts = new Map(); // lower-cased email -> { count, windowStart }

function tooManyResetAttempts(emailKey) {
  const now = Date.now();
  const entry = resetAttempts.get(emailKey);

  if (!entry || now - entry.windowStart > RESET_ATTEMPT_WINDOW_MS) {
    resetAttempts.set(emailKey, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > RESET_ATTEMPT_LIMIT;
}

// Exposed for tests only, so a run does not inherit another test's counter.
function clearResetAttempts() {
  resetAttempts.clear();
}

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

// Issues a fresh token to a driver whose current one still verifies.
//
// Tokens expire 30 days after login, and until this existed nothing renewed
// them: a driver who stayed logged in simply stopped being able to reach the
// backend one day, with every request answering 401 and the app blaming their
// phone's location settings. The app now calls this on every launch, so a
// driver who opens the app at least once a month never sees the expiry at all,
// and one who does not is sent back to the login screen with a clear message
// rather than left with a dead session.
//
// Sits behind requireDriverAuth, so an expired or tampered token cannot be
// used to mint a new one — only a valid one can be extended.
async function refreshToken(req, res) {
  try {
    const driver = await getPublicDriverById(req.driverId);
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    return res.json({ token: signDriverToken(driver.id), driver });
  } catch (error) {
    console.error("Error refreshing driver token:", error);
    const msg =
      (error && error.message === "Server misconfigured: missing JWT_SECRET")
        ? error.message
        : "Failed to refresh session";
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

// Sets a new password for a driver who has forgotten theirs, from the login
// screen, with no session.
//
// The proof that the person is the driver is that they know both the email and
// the phone number on the account. That is deliberately the free option — no
// email sending, no dispatcher in the loop — and it is weaker than an emailed
// code: anyone who knows a driver's email and phone can take the account. The
// owner chose it knowing that. What limits the damage is the rate limit above
// and the phone being compared in full, not just its last digits.
//
// One 401 message covers "no such email" and "phone does not match", so the
// endpoint cannot be used to find out which emails have accounts.
//
// Only password_hash changes. The driver's id, name, email, phone, orders and
// history stay exactly as they were — this is a reset, not a re-creation.
// Sessions already open on other phones stay valid: tokens are not tied to the
// hash, and forcing them out would need a token version column for a case
// that does not arise for a one-driver-one-phone team.
async function resetForgottenPassword(req, res) {
  try {
    const { email, phone, new_password } = req.body || {};

    if (!email || !phone || !new_password) {
      return res
        .status(400)
        .json({ error: "email, phone and new_password are required" });
    }

    if (String(new_password).length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `new_password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const emailKey = String(email).trim().toLowerCase();
    if (tooManyResetAttempts(emailKey)) {
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }

    const driver = await getDriverByEmail(String(email).trim());
    if (!driver || !phonesMatch(driver.phone, phone)) {
      return res.status(401).json({ error: "Email and phone number do not match" });
    }

    const newHash = await bcrypt.hash(String(new_password), 10);
    await updateDriverPassword(driver.id, newHash);
    resetAttempts.delete(emailKey);

    return res.json({ message: "Password reset" });
  } catch (error) {
    console.error("Error resetting driver password:", error);
    return res.status(500).json({ error: "Failed to reset password" });
  }
}

// Sets a new password for a logged-in driver who does not know their current
// one — the "Forgot your current password?" link on the profile screen.
//
// No current password is asked for because the session is the proof: the
// request carries a token that requireDriverAuth has just verified, which is
// stronger evidence than a password typed into a form. changePassword keeps
// asking for the current one so that a phone left unlocked cannot have its
// password quietly changed; this route accepts that trade for the driver who
// is locked out of their own settings.
async function resetOwnPassword(req, res) {
  try {
    const { new_password } = req.body || {};

    if (!new_password) {
      return res.status(400).json({ error: "new_password is required" });
    }

    if (String(new_password).length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `new_password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const driver = await getPublicDriverById(req.driverId);
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const newHash = await bcrypt.hash(String(new_password), 10);
    await updateDriverPassword(driver.id, newHash);

    return res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error resetting own driver password:", error);
    return res.status(500).json({ error: "Failed to reset password" });
  }
}

module.exports = {
  signupDriver,
  loginDriver,
  getMe,
  refreshToken,
  changePassword,
  resetForgottenPassword,
  resetOwnPassword,
  clearResetAttempts,
};
