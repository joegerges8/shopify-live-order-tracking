const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

async function loginAdmin(req, res) {
  try {
    const { shop, password } = req.body || {};

    if (!shop || !password) {
      return res.status(400).json({ error: "shop and password are required" });
    }

    const shopDomain = shop.trim().toLowerCase();

    const result = await pool.query(
      `SELECT id, admin_password_hash FROM stores WHERE shop_domain = $1 AND active = TRUE LIMIT 1`,
      [shopDomain]
    );
    const store = result.rows[0];

    if (!store || !store.admin_password_hash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, store.admin_password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { sub: "admin", type: "admin", storeId: store.id, shop: shopDomain },
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
