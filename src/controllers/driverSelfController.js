const {
  getOrdersByDriverId,
  getOrderById,
  updateOrderStatus,
  createLocationUpdate,
} = require("../services/orderService");

// Added in this change:
// Driver self-service controller (requires JWT via requireDriverAuth).
// - GET    /api/drivers/me/orders
// - POST   /api/drivers/me/orders/:id/location
// - PATCH  /api/drivers/me/orders/:id/status

async function getMyOrders(req, res) {
  try {
    const orders = await getOrdersByDriverId(req.driverId);
    return res.json(orders);
  } catch (error) {
    console.error("Error fetching driver orders:", error);
    return res.status(500).json({ error: "Failed to fetch orders" });
  }
}

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

async function patchMyOrderStatus(req, res) {
  try {
    const orderId = Number(req.params.id);
    const driverId = req.driverId;
    const { status } = req.body || {};

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
  postMyOrderLocation,
  patchMyOrderStatus,
};
