// require("dotenv").config();
// const app = require("./app");

// const PORT = process.env.PORT || 3000;

// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });

require("dotenv").config();

const app = require("./app");
const pool = require("./config/db");

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await pool.query("SELECT NOW()");
    console.log("Database connected successfully");

    // Idempotent migration — safe to run on every startup.
    // delivered_at was added after the initial schema, so older Railway
    // databases may not have it yet. Without this column every status
    // UPDATE (even to PENDING) fails because the SQL references it.
    await pool.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;`
    );
    console.log("Schema migration applied (delivered_at column ensured)");

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error("Startup failed:", error.message);
  }
}

startServer();