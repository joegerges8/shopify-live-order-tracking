
require("dotenv").config({ quiet: true });

const http = require("http");
const app = require("./app");
const pool = require("./config/db");
const { init: initSocket } = require("./socket");
const { syncWebhookSubscriptions } = require("./controllers/authController");

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
        prepaid BOOLEAN NOT NULL DEFAULT FALSE,
        fulfillment_status VARCHAR(50),
        order_status VARCHAR(30) DEFAULT 'UNFULFILLED',
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
    // What the dispatcher's area corrections have taught the classifier: an
    // unrecognized city string, filed by hand once, files itself from then on.
    // Keyed by the normalized city text and global across stores — a city is
    // a place on the ground, not a property of whoever sold the order.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS area_corrections (
        city_key TEXT PRIMARY KEY,
        area VARCHAR(50) NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_name VARCHAR(255);`);
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
    // Expiring offline tokens: Shopify's access tokens now last 60 minutes and
    // are renewed with a refresh token that itself lasts 90 days.
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS refresh_token TEXT;`);
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email VARCHAR(150) UNIQUE;`);
    // The driver's own last position, for the dispatcher's live map. Separate
    // from location_updates because that table is per-order, and a driver
    // waiting for their next job does not have one.
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_latitude NUMERIC(10,7);`);
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_longitude NUMERIC(10,7);`);
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id);`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;`);
    // When the driver set off with the order, and when it came back. The
    // Performance page runs on both: the average delivery time is measured
    // from the start of the trip rather than from when Shopify created the
    // order, and a return is dated by the day it happened rather than by the
    // day the order was placed — which used to keep returns of older orders
    // out of the day being read entirely.
    // Where each order falls in its driver's run. Existing rows stay NULL and
    // sort to the bottom of the driver's list until the next assignment for
    // that driver reorders it, so no backfill is required to deploy this —
    // scripts/resequence-routes.js --all fills them in one pass if wanted.
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS route_sequence INT;`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS returned_at TIMESTAMP;`);
    // Drives the dashboard's retention window for completed orders.
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMP;`);
    // Records whether the customer had already paid online before delivery.
    // financial_status cannot answer that after the fact: delivering a COD
    // order sets it to 'paid' as well, which made the driver app count that
    // money twice — once as cash in hand, once in the earnings total.
    const prepaidColumn = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'orders' AND column_name = 'prepaid'`
    );
    await pool.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepaid BOOLEAN NOT NULL DEFAULT FALSE;`
    );
    if (prepaidColumn.rowCount === 0) {
      // One-off backfill, guarded so it only runs on the migration itself:
      // an order that had not been delivered yet can only be 'paid' because
      // the customer paid online. Delivered rows are left FALSE — their
      // status was overwritten on delivery and the original is unrecoverable.
      const backfill = await pool.query(
        `UPDATE orders SET prepaid = TRUE
         WHERE financial_status = 'paid' AND delivered_at IS NULL`
      );
      console.log(`Added orders.prepaid and backfilled ${backfill.rowCount} undelivered paid orders`);
    }
    // How the customer actually paid, when it was not the default for the
    // order: 'WHISH' when the driver recorded a Whish transfer at the door
    // instead of taking cash. NULL means the ordinary case, so no backfill.
    await pool.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);`
    );
    // Orders shipped by an outside carrier — Wakilni and the like — rather than
    // by our own drivers. The carrier writes its tracking link onto the Shopify
    // fulfilment, and that link is what the customer must be sent to.
    await pool.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier_tracking_url TEXT;`
    );
    await pool.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier_name VARCHAR(100);`
    );
    // The carrier's own progress — Confirmed, In transit, Delivered — which is
    // the only signal the shop gets for a delivery it is not running itself.
    // Existing carrier orders stay NULL until the carrier's next shipment
    // event, or until the next Shopify sync reads it off the fulfilment.
    await pool.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier_status VARCHAR(40);`
    );
    await pool.query(
      `ALTER TABLE orders
       ALTER COLUMN order_status SET DEFAULT 'UNFULFILLED'`
    );
    await pool.query(
      `UPDATE orders
       SET order_status = 'UNFULFILLED'
       WHERE order_status IS NULL OR order_status IN ('CREATED', 'PENDING')`
    );

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

      -- The dispatcher live map asks for each driver's newest fix. Without
      -- this it walks a table that gains a row every 15 seconds per delivery.
      CREATE INDEX IF NOT EXISTS idx_location_updates_driver_created
        ON location_updates (driver_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_orders_tracking_token
        ON orders (tracking_token);

      CREATE INDEX IF NOT EXISTS idx_orders_store_created
        ON orders (store_id, created_at DESC);
    `);
    console.log("Schema migrations applied");

    // Fire-and-forget: a store missing a webhook topic added since it was
    // installed gets subscribed now. Shopify being slow or down must not keep
    // the server from starting.
    syncWebhookSubscriptions().catch((error) =>
      console.error("[Webhooks] Startup sync failed:", error.message)
    );

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
