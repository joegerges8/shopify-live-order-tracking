// require("dotenv").config();
// const app = require("./app");

// const PORT = process.env.PORT || 3000;

// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });

require("dotenv").config({ quiet: true });

const http = require("http");
const app = require("./app");
const pool = require("./config/db");
const { init: initSocket } = require("./socket");

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await pool.query("SELECT NOW()");
    console.log("Database connected successfully");

    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;`);

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
