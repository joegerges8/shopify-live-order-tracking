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
//   Dispatcher reporting routes (admin JWT required):
//     GET /api/drivers/performance       — every driver's deliveries, cash and pay
//     GET /api/drivers/:id/performance   — one driver's figures plus the orders behind them
//     GET /api/drivers/locations         — every driver's latest GPS fix (live map)
//
//   Protected routes (JWT required via requireDriverAuth middleware):
//     GET    /api/drivers/me                         — get own profile
//     POST   /api/drivers/me/password                — change password
//     GET    /api/drivers/me/orders                  — active assigned orders
//     GET    /api/drivers/me/orders/completed        — completed (delivered) orders
//     GET    /api/drivers/me/orders/returned         — returned orders
//     POST   /api/drivers/me/location                — post own position (live map)
//     POST   /api/drivers/me/orders/:id/location     — post a GPS ping
//     PATCH  /api/drivers/me/orders/:id/status       — update delivery status
//     PATCH  /api/drivers/me/orders/:id/note         — save the driver's own note
//
// IMPORTANT: The /me/orders/completed and /me/orders/returned routes MUST be
// defined before the
// /me/orders/:id/location and /me/orders/:id/status routes. Express matches
// routes in the order they are declared, so if the :id routes came first,
// the word "completed" (or "returned") would be treated as an order ID.

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
  getMyReturnedOrders,
  postMyLocation,
  postMyOrderLocation,
  patchMyOrderStatus,
  patchMyOrderNote,
} = require("../controllers/driverSelfController");

const {
  getDrivers,
  getDriverLocations,
  createNewDriver,
  deleteDriver,
} = require("../controllers/driverController");

const {
  getPerformance,
  getPerformanceForDriver,
} = require("../controllers/performanceController");

// ── Public auth routes ─────────────────────────────────────────────────────
router.post("/signup", signupDriver);
router.post("/login", loginDriver);

// ── Protected self-service routes ─────────────────────────────────────────
// requireDriverAuth verifies the Bearer token and sets req.driverId.
router.get("/me", requireDriverAuth, getMe);
router.post("/me/password", requireDriverAuth, changePassword);

// Returns only active (non-delivered, non-cancelled) orders for this driver.
router.get("/me/orders", requireDriverAuth, getMyOrders);

// Posts the driver's own position, with no order attached — what the
// dispatcher's live map runs on. Declared before the /me/orders/... routes so
// it cannot be mistaken for one of them.
router.post("/me/location", requireDriverAuth, postMyLocation);

// Returns completed (DELIVERED) orders for this driver.
// Declared before /me/orders/:id/... to prevent "completed" being parsed as an ID.
router.get("/me/orders/completed", requireDriverAuth, getMyCompletedOrders);

// Returns returned orders for this driver — the app's Returned tab reads this
// on startup, so a return survives the app being closed. Declared here for the
// same reason as /me/orders/completed above.
router.get("/me/orders/returned", requireDriverAuth, getMyReturnedOrders);

// Posts a GPS coordinate ping for a specific order (live tracking).
router.post("/me/orders/:id/location", requireDriverAuth, postMyOrderLocation);

// Updates the delivery status of a specific order (e.g. DELIVERED).
router.patch("/me/orders/:id/status", requireDriverAuth, patchMyOrderStatus);

// Saves the driver's own note on a specific order.
router.patch("/me/orders/:id/note", requireDriverAuth, patchMyOrderNote);

// ── Dispatcher / admin routes ──────────────────────────────────────────────
// Kept above the "/:id" routes below so a future GET /:id cannot swallow
// "performance" as a driver ID — the same trap /me/orders/completed sits in.
router.get("/performance", requireAdminAuth, getPerformance);
router.get("/:id/performance", requireAdminAuth, getPerformanceForDriver);

// Every driver's latest GPS position — the live map on the dashboard.
// Sits with the other literal paths, above "/:id", for the same reason.
router.get("/locations", requireAdminAuth, getDriverLocations);

router.get("/", requireAdminAuth, getDrivers);
router.post("/", requireAdminAuth, createNewDriver);
router.delete("/:id", requireAdminAuth, deleteDriver);

module.exports = router;
