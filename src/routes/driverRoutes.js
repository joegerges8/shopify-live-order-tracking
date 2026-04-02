const express = require("express");
const router = express.Router();
const {
  getDrivers,
  createNewDriver,
} = require("../controllers/driverController");

router.get("/", getDrivers);
router.post("/", createNewDriver);

module.exports = router;