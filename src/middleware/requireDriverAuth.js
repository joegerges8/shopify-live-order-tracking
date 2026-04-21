const jwt = require("jsonwebtoken");

// Added in this change:
// Express middleware to protect driver-only endpoints.
// - Expects: Authorization: Bearer <JWT>
// - Verifies with process.env.JWT_SECRET
// - On success sets req.driverId
function requireDriverAuth(req, res, next) {
  try {
    const authHeader = req.get("Authorization") || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }

    const secret = (process.env.JWT_SECRET || "").trim();
    if (!secret) {
      console.error("[Auth] Missing JWT_SECRET env var");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const payload = jwt.verify(token, secret);

    if (!payload || payload.type !== "driver" || !payload.sub) {
      return res.status(401).json({ error: "Invalid token" });
    }

    req.driverId = Number(payload.sub);

    if (!Number.isFinite(req.driverId)) {
      return res.status(401).json({ error: "Invalid token" });
    }

    return next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

module.exports = requireDriverAuth;
