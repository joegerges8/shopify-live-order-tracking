const express = require("express");
const router = express.Router();

const verifyShopifyWebhook = require("../middleware/verifyShopifyWebhook");
const { handleOrderCreated } = require("../controllers/webhookController");

router.post(
  "/orders/create",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleOrderCreated
);

module.exports = router;