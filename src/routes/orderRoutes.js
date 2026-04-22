const express = require("express");
const router = express.Router();
const {
  getOrders,
  assignDriver,
  unassignDriver,
  changeOrderStatus,
} = require("../controllers/orderController");

router.get("/", getOrders);
router.patch("/:id/assign-driver", assignDriver);
router.patch("/:id/unassign-driver", unassignDriver);
router.patch("/:id/status", changeOrderStatus);
module.exports = router;