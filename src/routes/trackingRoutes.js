const express = require("express");
const router = express.Router();
const { getOrderByTrackingToken } = require("../services/orderService");
const { etaForTrackedOrder, hasDriverStarted } = require("../services/etaService");

// Why there is no ETA, so a blank line on the page can be explained without
// reading server logs. Returned alongside `eta` on every tracking response.
//
//   ok                  — an ETA is present
//   waiting_for_driver  — no GPS yet, or the driver has not tapped
//                         "Start Delivery" (their last ping has gone stale)
//   not_started         — the order is not out for delivery yet
//   unavailable         — the driver is on the road but the delivery city
//                         could not be resolved to anywhere we can locate
function etaStatusFor(order, eta) {
  if (eta) return "ok";
  if (!["PICKED_UP", "OUT_FOR_DELIVERY"].includes(order.order_status)) {
    return "not_started";
  }
  if (!driverHasSetOff(order)) {
    return "waiting_for_driver";
  }
  return "unavailable";
}

// Has the driver actually set off? Per-order GPS pings start when — and only
// when — the driver taps "Start Delivery" in their app, so a recent ping is
// the honest answer. The dispatcher flipping an order to PICKED_UP is not:
// the parcel is on the counter, not on the road.
//
// An old ping means a delivery that was started at some point and has since
// gone quiet (app closed, phone asleep), which is not something to show a
// customer as live either — hence the freshness window rather than a plain
// null check.
function driverHasSetOff(order) {
  return Boolean(order.driver_lat) && hasDriverStarted(order.location_age_seconds);
}

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
      // What the tracking page uses to tell "picked up" from "on the way": the
      // headline, the live badge and the driver marker all hang off this.
      driver_started: driverHasSetOff(order),
      eta,
      eta_status: etaStatusFor(order, eta),
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
