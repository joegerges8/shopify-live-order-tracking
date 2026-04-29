const jwt = require("jsonwebtoken");

function requireAdminAuth(req, res, next) {
  try {
    const [scheme, token] = (req.get("Authorization") || "").split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || payload.type !== "admin") {
      return res.status(401).json({ error: "Invalid token" });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

module.exports = requireAdminAuth;
