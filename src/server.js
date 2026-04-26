// require("dotenv").config();
// const app = require("./app");

// const PORT = process.env.PORT || 3000;

// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });

require("dotenv").config();

const http = require("http");
const app = require("./app");
const pool = require("./config/db");
const { init: initSocket } = require("./socket");

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await pool.query("SELECT NOW()");
    console.log("Database connected successfully");

    await pool.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;`
    );
    console.log("Schema migration applied (delivered_at column ensured)");

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