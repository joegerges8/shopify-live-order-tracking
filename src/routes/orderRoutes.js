const express = require("express");
const router = express.Router();
const {
  getOrders,
  assignDriver,
  unassignDriver,
  changeOrderStatus,
  setCustomerLocation,
  importOrders,
} = require("../controllers/orderController");

router.get("/", getOrders);
router.post("/import", importOrders);
router.patch("/:id/assign-driver", assignDriver);
router.patch("/:id/unassign-driver", unassignDriver);
router.patch("/:id/status", changeOrderStatus);
router.patch("/:id/customer-location", setCustomerLocation);
module.exports = router;