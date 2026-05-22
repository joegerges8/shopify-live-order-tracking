const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

async function loginAdmin(req, res) {
  try {
    const { shop, password } = req.body || {};

    if (!shop || !password) {
      return res.status(400).json({ error: "shop and password are required" });
    }

    const input = shop.trim();

    // Look up by shop_domain if it looks like a myshopify domain, otherwise by store_name
    let result;
    if (input.toLowerCase().endsWith(".myshopify.com")) {
      result = await pool.query(
        `SELECT id, admin_password_hash, shop_domain, store_name FROM stores WHERE shop_domain = $1 AND active = TRUE LIMIT 1`,
        [input.toLowerCase()]
      );
    } else {
      result = await pool.query(
        `SELECT id, admin_password_hash, shop_domain, store_name FROM stores WHERE LOWER(store_name) = LOWER($1) AND active = TRUE LIMIT 1`,
        [input]
      );
    }
    const store = result.rows[0];

    if (!store || !store.admin_password_hash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, store.admin_password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { sub: "admin", type: "admin", storeId: store.id, shop: store.shop_domain },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({ token, storeName: store.store_name || store.shop_domain });
  } catch (error) {
    console.error("Error logging in admin:", error);
    return res.status(500).json({ error: "Failed to log in" });
  }
}

module.exports = { loginAdmin };
