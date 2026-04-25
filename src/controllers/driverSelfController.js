// driverSelfController.js
//
// Handles HTTP requests for the driver's own data — orders, location updates,
// and status changes. Every route in this controller is protected by the
// requireDriverAuth middleware, which verifies the JWT token in the
// Authorization header and attaches the driver's ID to req.driverId.
//
// Routes handled here:
//   GET    /api/drivers/me/orders           — fetch active (pending) orders
//   GET    /api/drivers/me/orders/completed — fetch completed (delivered) orders
//   POST   /api/drivers/me/orders/:id/location — post a GPS ping
//   PATCH  /api/drivers/me/orders/:id/status   — update delivery status

const {
  getOrdersByDriverId,
  getCompletedOrdersByDriverId,
  getOrderById,
  updateOrderStatus,
  createLocationUpdate,
} = require("../services/orderService");

// Returns all active orders assigned to the authenticated driver.
// "Active" means any status except DELIVERED or CANCELLED, so the driver
// only sees orders they still need to act on.
async function getMyOrders(req, res) {
  try {
    const orders = await getOrdersByDriverId(req.driverId);
    return res.json(orders);
  } catch (error) {
    console.error("Error fetching driver orders:", error);
    return res.status(500).json({ error: "Failed to fetch orders" });
  }
}

// Returns all completed (DELIVERED) orders for the authenticated driver.
// This powers the "Done" tab in the driver app and the earnings summary strip.
// It is a separate endpoint from getMyOrders so that pending and completed
// orders are never mixed in the same response.
async function getMyCompletedOrders(req, res) {
  try {
    const orders = await getCompletedOrdersByDriverId(req.driverId);
    return res.json(orders);
  } catch (error) {
    console.error("Error fetching completed orders:", error);
    return res.status(500).json({ error: "Failed to fetch completed orders" });
  }
}

// Records a GPS coordinate from the driver's device for a specific order.
// The driver app calls this periodically while delivering so the customer's
// live-tracking page can show the driver's real-time location on a map.
//
// Validation checks:
//   - orderId must be a finite number (rejects "abc" or NaN).
//   - latitude and longitude must be numbers (rejects strings or missing fields).
//   - The order must exist in the database.
//   - The order must belong to the authenticated driver (prevents one driver
//     from posting fake locations for another driver's order).
async function postMyOrderLocation(req, res) {
  try {
    const orderId = Number(req.params.id);
    const driverId = req.driverId;
    const { latitude, longitude } = req.body || {};

    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return res
        .status(400)
        .json({ error: "latitude and longitude must be numbers" });
    }

    const order = await getOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Ownership check — a driver can only post locations for their own orders.
    if (order.assigned_driver_id !== driverId) {
      return res.status(403).json({ error: "Not allowed for this order" });
    }

    const created = await createLocationUpdate({
      order_id: orderId,
      driver_id: driverId,
      latitude,
      longitude,
    });

    return res.status(201).json(created);
  } catch (error) {
    console.error("Error creating location update:", error);
    return res.status(500).json({ error: "Failed to create location update" });
  }
}

// Updates the delivery status of an order (e.g. from ASSIGNED to PICKED_UP,
// or from OUT_FOR_DELIVERY to DELIVERED). When status becomes DELIVERED, the
// database automatically stamps the delivered_at timestamp via the SQL CASE
// expression in updateOrderStatus().
//
// Validation checks:
//   - orderId must be valid.
//   - status must be one of the predefined valid values.
//   - The order must exist and belong to the authenticated driver.
async function patchMyOrderStatus(req, res) {
  try {
    const orderId = Number(req.params.id);
    const driverId = req.driverId;
    const { status } = req.body || {};

    // Whitelist of allowed status transitions — rejects any arbitrary string.
    const validStatuses = [
      "PENDING",
      "ASSIGNED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "CANCELLED",
    ];

    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const order = await getOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Ownership check — a driver can only update their own orders.
    if (order.assigned_driver_id !== driverId) {
      return res.status(403).json({ error: "Not allowed for this order" });
    }

    const updated = await updateOrderStatus(orderId, status);
    return res.json(updated);
  } catch (error) {
    console.error("Error updating driver order status:", error);
    return res.status(500).json({ error: "Failed to update order status" });
  }
}

module.exports = {
  getMyOrders,
  getMyCompletedOrders,
  postMyOrderLocation,
  patchMyOrderStatus,
};
