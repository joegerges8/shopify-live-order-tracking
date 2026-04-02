const express = require("express");
const router = express.Router();
const {
  getOrders,
  assignDriver,
  changeOrderStatus,
} = require("../controllers/orderController");

router.get("/", getOrders);
router.patch("/:id/assign-driver", assignDriver);
router.patch("/:id/status", changeOrderStatus);
module.exports = router;