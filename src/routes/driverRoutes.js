const express = require("express");
const router = express.Router();

// Added in this change:
// - Driver authentication endpoints (signup/login) that return a JWT.
// - Protected driver self-service endpoints (/me, /me/orders, location, status)
//   secured by Authorization: Bearer <token>.
// - POST /api/drivers/me/password: new change-password endpoint added to fix the bug where
//   the Flutter app showed a fake success without ever updating the password in the database.
// Existing dispatcher/admin endpoints (GET /, POST /) remain unchanged.

const requireDriverAuth = require("../middleware/requireDriverAuth");

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
} = require("../controllers/driverController");

router.post("/signup", signupDriver);
router.post("/login", loginDriver);
router.get("/me", requireDriverAuth, getMe);
router.post("/me/password", requireDriverAuth, changePassword);
router.get("/me/orders", requireDriverAuth, getMyOrders);
router.get("/me/orders/completed", requireDriverAuth, getMyCompletedOrders);
router.post("/me/orders/:id/location", requireDriverAuth, postMyOrderLocation);
router.patch("/me/orders/:id/status", requireDriverAuth, patchMyOrderStatus);

router.get("/", getDrivers);
router.post("/", createNewDriver);

module.exports = router;