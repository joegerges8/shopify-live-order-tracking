const jwt = require("jsonwebtoken");
const pool = require("../config/db");

async function requireAdminAuth(req, res, next) {
  const [scheme, token] = (req.get("Authorization") || "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!payload || payload.type !== "admin" || !payload.storeId) {
    return res.status(401).json({ error: "Invalid token" });
  }

  // A token outlives the store row it points at when the app is uninstalled and
  // reinstalled — the new install gets a new store id. Without this check the
  // session keeps querying a store that no longer exists, and the dispatcher
  // just sees an empty order list with no explanation.
  try {
    const result = await pool.query(
      `SELECT id FROM stores WHERE id = $1 AND active = TRUE LIMIT 1`,
      [payload.storeId]
    );
    if (!result.rows[0]) {
      console.warn(
        `[Auth] Token references missing store ${payload.storeId} ` +
        `(${payload.shop || "unknown shop"}) — forcing re-login`
      );
      return res.status(401).json({ error: "Your session is out of date. Please log in again." });
    }
  } catch (error) {
    console.error("[Auth] Store lookup failed:", error.message);
    return res.status(500).json({ error: "Failed to verify session" });
  }

  req.storeId = payload.storeId;
  req.shopDomain = payload.shop;
  return next();
}

module.exports = requireAdminAuth;
