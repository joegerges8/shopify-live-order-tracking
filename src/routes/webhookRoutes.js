const express = require("express");
const router = express.Router();

const verifyShopifyWebhook = require("../middleware/verifyShopifyWebhook");
const {
  handleOrderCreated,
  handleOrderCancelled,
  handleOrderDeleted,
  handleOrderFulfilled,
  handleCustomerDataRequest,
  handleCustomerRedact,
  handleShopRedact,
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

// Compatibility alias in case webhook URL is configured with US spelling.
router.post(
  "/orders/canceled",
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

// Compatibility alias in case webhook URL is configured as /orders/deleted.
router.post(
  "/orders/deleted",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleOrderDeleted
);

router.post(
  "/orders/fulfilled",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleOrderFulfilled
);

router.post(
  "/customers/data_request",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleCustomerDataRequest
);

router.post(
  "/customers/redact",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleCustomerRedact
);

router.post(
  "/shop/redact",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleShopRedact
);

module.exports = router;
