const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

async function loginAdmin(req, res) {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const expectedUsername = (process.env.ADMIN_USERNAME || "").trim();
    const expectedPasswordHash = (process.env.ADMIN_PASSWORD || "").trim();

    if (!expectedUsername || !expectedPasswordHash) {
      console.error("[AdminAuth] ADMIN_USERNAME or ADMIN_PASSWORD env var is missing");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    if (username !== expectedUsername) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, expectedPasswordHash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { sub: "admin", type: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({ token });
  } catch (error) {
    console.error("Error logging in admin:", error);
    return res.status(500).json({ error: "Failed to log in" });
  }
}

module.exports = { loginAdmin };
