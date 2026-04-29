// driverSelfController.js
//
// Handles HTTP requests for the driver's own data: orders, location updates,
// and status changes. Every route in this controller is protected by the
// requireDriverAuth middleware, which verifies the JWT token in the
// Authorization header and attaches the driver's ID to req.driverId.

const {
  getOrdersByDriverId,
  getCompletedOrdersByDriverId,
  getOrderById,
  updateDriverOrderStatus,
  createLocationUpdate,
} = require("../services/orderService");
const { getIO } = require("../socket");

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

    const io = getIO();
    if (io && order.tracking_token) {
      io.to(`order:${order.tracking_token}`).emit("location_update", {
        latitude,
        longitude,
        updated_at: created.created_at,
      });
    }

    return res.status(201).json(created);
  } catch (error) {
    console.error("Error creating location update:", error);
    return res.status(500).json({ error: "Failed to create location update" });
  }
}

// Updates an order status from the driver app. The ownership check is folded
// into the UPDATE query so the normal "Mark as Picked Up" path uses one DB call.
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

    const updated = await updateDriverOrderStatus(orderId, driverId, status);
    if (!updated) {
      const order = await getOrderById(orderId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      return res.status(403).json({ error: "Not allowed for this order" });
    }

    const io = getIO();
    if (io && updated.tracking_token) {
      io.to(`order:${updated.tracking_token}`).emit("status_update", { status });
    }

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
