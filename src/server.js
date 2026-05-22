
require("dotenv").config({ quiet: true });

const http = require("http");
const app = require("./app");
const pool = require("./config/db");
const { init: initSocket } = require("./socket");

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
   //test if the database connection works by running a simple query. If it fails, we catch the error and log it.
    await pool.query("SELECT NOW()");
    console.log("Database connected successfully");

    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;`);

    // Multi-tenant: stores table + store_id on orders
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id              SERIAL PRIMARY KEY,
        shop_domain     VARCHAR(255) UNIQUE NOT NULL,
        access_token    TEXT NOT NULL DEFAULT '',
        admin_password_hash TEXT,
        setup_token     TEXT,
        scope           TEXT,
        installed_at    TIMESTAMP DEFAULT NOW(),
        active          BOOLEAN DEFAULT TRUE
      );
    `);
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_name VARCHAR(255);`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id);`);

    // Seed the original single store from env so existing orders remain visible
    const seedShop = (process.env.SHOPIFY_STORE || "").trim();
    const seedPass = (process.env.ADMIN_PASSWORD || "").trim();
    if (seedShop) {
      const seedResult = await pool.query(`
        INSERT INTO stores (shop_domain, admin_password_hash)
        VALUES ($1, $2)
        ON CONFLICT (shop_domain) DO NOTHING
        RETURNING id
      `, [seedShop, seedPass || null]);
      if (seedResult.rows.length > 0) {
        const seedId = seedResult.rows[0].id;
        await pool.query(`UPDATE orders SET store_id = $1 WHERE store_id IS NULL`, [seedId]);
        console.log(`Seeded store ${seedShop} (id=${seedId}) and backfilled existing orders`);
      }
    }

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_driver_active
        ON orders (assigned_driver_id, created_at DESC)
        WHERE order_status NOT IN ('DELIVERED', 'CANCELLED');

      CREATE INDEX IF NOT EXISTS idx_orders_driver_delivered
        ON orders (assigned_driver_id, (COALESCE(delivered_at, created_at)) DESC)
        WHERE order_status = 'DELIVERED';

      CREATE INDEX IF NOT EXISTS idx_location_updates_order_created
        ON location_updates (order_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_orders_tracking_token
        ON orders (tracking_token);
    `);
    console.log("Schema migrations applied");

    const server = http.createServer(app);
    initSocket(server);

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error("Startup failed:", error.message);
  }
}

startServer();
