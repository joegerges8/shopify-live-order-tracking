
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

    // Multi-tenant: stores have their own orders; drivers are shared globally.
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE,
        phone VARCHAR(30) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        status VARCHAR(30) DEFAULT 'AVAILABLE',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        store_id INT REFERENCES stores(id) ON DELETE CASCADE,
        shopify_order_id BIGINT UNIQUE NOT NULL,
        order_number VARCHAR(50),
        customer_first_name VARCHAR(100),
        customer_last_name VARCHAR(100),
        customer_phone VARCHAR(30),
        customer_email VARCHAR(150),
        shipping_address TEXT,
        city VARCHAR(100),
        country VARCHAR(100),
        total_price NUMERIC(10,2),
        financial_status VARCHAR(50),
        fulfillment_status VARCHAR(50),
        order_status VARCHAR(30) DEFAULT 'PENDING',
        assigned_driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
        tracking_token TEXT,
        customer_latitude NUMERIC(10,7),
        customer_longitude NUMERIC(10,7),
        customer_altitude NUMERIC(10,2),
        google_maps_link TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS location_updates (
        id SERIAL PRIMARY KEY,
        order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
        latitude NUMERIC(10,7) NOT NULL,
        longitude NUMERIC(10,7) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_name VARCHAR(255);`);
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email VARCHAR(150) UNIQUE;`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id);`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;`);

    // Seed the original single store from env so existing orders remain visible
    const seedShop = (process.env.SHOPIFY_STORE || "").trim();
    const seedPass = (process.env.ADMIN_PASSWORD || "").trim();
    if (seedShop) {
      const seedResult = await pool.query(`
        INSERT INTO stores (shop_domain, admin_password_hash)
        VALUES ($1, $2)
        ON CONFLICT (shop_domain) DO UPDATE
          SET shop_domain = EXCLUDED.shop_domain
        RETURNING id
      `, [seedShop, seedPass || null]);
      if (seedResult.rows.length > 0) {
        const seedId = seedResult.rows[0].id;
        await pool.query(`UPDATE orders SET store_id = $1 WHERE store_id IS NULL`, [seedId]);
        console.log(`Seeded store ${seedShop} (id=${seedId}) and backfilled existing orders`);
      }
    }

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM orders WHERE store_id IS NULL) THEN
          ALTER TABLE orders ALTER COLUMN store_id SET NOT NULL;
        END IF;
      END $$;
    `);

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
