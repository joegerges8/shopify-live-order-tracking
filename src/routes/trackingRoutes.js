const express = require("express");
const router = express.Router();
const { getOrderByTrackingToken } = require("../services/orderService");

// Public endpoint — no auth required. The token is the credential.
// GET /api/track/:token
router.get("/:token", async (req, res) => {
  try {
    const order = await getOrderByTrackingToken(req.params.token);
    if (!order) return res.status(404).json({ error: "Tracking link not found" });

    res.json({
      order_number: order.order_number,
      order_status: order.order_status,
      customer_name: [order.customer_first_name, order.customer_last_name]
        .filter(Boolean)
        .join(" "),
      delivery_address: [order.shipping_address, order.city]
        .filter(Boolean)
        .join(", "),
      customer_latitude: order.customer_latitude,
      customer_longitude: order.customer_longitude,
      delivered_at: order.delivered_at,
      driver: order.driver_name ? { name: order.driver_name } : null,
      driver_location:
        order.driver_lat != null
          ? {
              latitude: order.driver_lat,
              longitude: order.driver_lng,
              updated_at: order.location_updated_at,
            }
          : null,
    });
  } catch (error) {
    console.error("Tracking error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
