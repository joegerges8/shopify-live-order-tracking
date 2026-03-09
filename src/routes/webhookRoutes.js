const express = require("express");
const router = express.Router();

const verifyShopifyWebhook = require("../middleware/verifyShopifyWebhook");
const {
  handleOrderCreated,
  handleOrderCancelled,
  handleOrderDeleted,
} = require("../controllers/webhookController");

// Each route matches a Shopify webhook topic under /webhooks/shopify.
router.post(
  "/orders/create",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleOrderCreated
);

router.post(
  "/orders/cancelled",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleOrderCancelled
);

router.post(
  "/orders/delete",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleOrderDeleted
);

module.exports = router;