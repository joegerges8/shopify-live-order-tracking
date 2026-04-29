// driverRoutes.js
//
// Defines all HTTP routes under the /api/drivers prefix.
// Routes are split into two groups:
//
//   Public routes (no authentication required):
//     POST /api/drivers/signup  — register a new driver account
//     POST /api/drivers/login   — log in and receive a JWT token
//     GET  /api/drivers/        — list all drivers (dispatcher panel)
//     POST /api/drivers/        — create a driver (dispatcher panel)
//
//   Protected routes (JWT required via requireDriverAuth middleware):
//     GET    /api/drivers/me                         — get own profile
//     POST   /api/drivers/me/password                — change password
//     GET    /api/drivers/me/orders                  — active assigned orders
//     GET    /api/drivers/me/orders/completed        — completed (delivered) orders
//     POST   /api/drivers/me/orders/:id/location     — post a GPS ping
//     PATCH  /api/drivers/me/orders/:id/status       — update delivery status
//
// IMPORTANT: The /me/orders/completed route MUST be defined before the
// /me/orders/:id/location and /me/orders/:id/status routes. Express matches
// routes in the order they are declared, so if the :id routes came first,
// the word "completed" would be treated as an order ID.

const express = require("express");
const router = express.Router();

const requireDriverAuth = require("../middleware/requireDriverAuth");
const requireAdminAuth = require("../middleware/requireAdminAuth");

const {
  signupDriver,
  loginDriver,
  getMe,
  changePassword,
} = require("../controllers/driverAuthController");

const {
  getMyOrders,
  getMyCompletedOrders,
  postMyOrderLocation,
  patchMyOrderStatus,
} = require("../controllers/driverSelfController");

const {
  getDrivers,
  createNewDriver,
  deleteDriver,
} = require("../controllers/driverController");

// ── Public auth routes ─────────────────────────────────────────────────────
router.post("/signup", signupDriver);
router.post("/login", loginDriver);

// ── Protected self-service routes ─────────────────────────────────────────
// requireDriverAuth verifies the Bearer token and sets req.driverId.
router.get("/me", requireDriverAuth, getMe);
router.post("/me/password", requireDriverAuth, changePassword);

// Returns only active (non-delivered, non-cancelled) orders for this driver.
router.get("/me/orders", requireDriverAuth, getMyOrders);

// Returns completed (DELIVERED) orders for this driver.
// Declared before /me/orders/:id/... to prevent "completed" being parsed as an ID.
router.get("/me/orders/completed", requireDriverAuth, getMyCompletedOrders);

// Posts a GPS coordinate ping for a specific order (live tracking).
router.post("/me/orders/:id/location", requireDriverAuth, postMyOrderLocation);

// Updates the delivery status of a specific order (e.g. DELIVERED).
router.patch("/me/orders/:id/status", requireDriverAuth, patchMyOrderStatus);

// ── Dispatcher / admin routes ──────────────────────────────────────────────
router.get("/", requireAdminAuth, getDrivers);
router.post("/", requireAdminAuth, createNewDriver);
router.delete("/:id", requireAdminAuth, deleteDriver);

module.exports = router;
