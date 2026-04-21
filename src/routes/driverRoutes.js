const express = require("express");
const router = express.Router();

// Added in this change:
// - Driver authentication endpoints (signup/login) that return a JWT.
// - Protected driver self-service endpoints (/me, /me/orders, location, status)
//   secured by Authorization: Bearer <token>.
// Existing dispatcher/admin endpoints (GET /, POST /) remain unchanged.

const requireDriverAuth = require("../middleware/requireDriverAuth");

const {
  signupDriver,
  loginDriver,
  getMe,
} = require("../controllers/driverAuthController");

const {
  getMyOrders,
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
router.get("/me/orders", requireDriverAuth, getMyOrders);
router.post("/me/orders/:id/location", requireDriverAuth, postMyOrderLocation);
router.patch("/me/orders/:id/status", requireDriverAuth, patchMyOrderStatus);

router.get("/", getDrivers);
router.post("/", createNewDriver);

module.exports = router;