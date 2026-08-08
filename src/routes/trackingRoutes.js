const express = require("express");
const router = express.Router();
const { getOrderByTrackingToken } = require("../services/orderService");
const { etaForTrackedOrder } = require("../services/etaService");

// Public endpoint — no auth required. The token is the credential.
// GET /api/track/:token
router.get("/:token", async (req, res) => {
  try {
    const order = await getOrderByTrackingToken(req.params.token);
    if (!order) return res.status(404).json({ error: "Tracking link not found" });

    // The ETA is best-effort: a Directions outage or an unknown town must never
    // take down the tracking page, it just means no ETA this time round.
    let eta = null;
    try {
      eta = await etaForTrackedOrder(order);
    } catch (error) {
      console.error("ETA error:", error);
    }

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
      eta,
      driver: order.driver_name ? { name: order.driver_name, phone: order.driver_phone || null } : null,
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
