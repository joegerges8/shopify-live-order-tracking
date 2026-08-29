const express = require("express");
const router = express.Router();

const verifyShopifyWebhook = require("../middleware/verifyShopifyWebhook");
const {
  handleOrderCreated,
  handleOrderUpdated,
  handleOrderCancelled,
  handleOrderDeleted,
  handleOrderFulfilled,
  handleFulfillmentUpdated,
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

// Carries the order note, and the products and total after an order is edited
// in the Shopify admin.
router.post(
  "/orders/updated",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleOrderUpdated
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

// How an outside carrier's own progress reaches the dashboard: Wakilni moves
// the shipment from Confirmed to Delivered on the fulfilment, long after
// orders/fulfilled has had its say. Both topics land here — create carries the
// carrier's tracking link, update carries every status change after it.
router.post(
  "/fulfillments/create",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleFulfillmentUpdated
);

router.post(
  "/fulfillments/update",
  express.raw({ type: "*/*" }),
  verifyShopifyWebhook,
  handleFulfillmentUpdated
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
