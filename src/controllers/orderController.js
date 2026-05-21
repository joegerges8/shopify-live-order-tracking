const {
  getAllOrders,
  getOrderById,
  assignDriverToOrder,
  unassignDriverFromOrder,
  updateOrderStatus,
  updateCustomerLocation,
} = require("../services/orderService");
const { parseMapLink } = require("../utils/parseMapLink");
const pool = require("../config/db");

async function getOrders(req, res) {
  try {
    const orders = await getAllOrders(req.storeId);
    return res.json(orders);
  } catch (error) {
    console.error("Error fetching orders:", error);
    return res.status(500).json({ error: "Failed to fetch orders" });
  }
}

async function assignDriver(req, res) {
  try {
    const orderId = req.params.id;
    const { driverId } = req.body;

    if (!driverId) {
      return res.status(400).json({ error: "driverId is required" });
    }

    const order = await getOrderById(orderId, req.storeId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const driverResult = await pool.query(
      `SELECT * FROM drivers WHERE id = $1 LIMIT 1`,
      [driverId]
    );
    if (!driverResult.rows[0]) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const updatedOrder = await assignDriverToOrder(orderId, driverId, req.storeId);
    return res.json(updatedOrder);
  } catch (error) {
    console.error("Error assigning driver:", error);
    return res.status(500).json({ error: "Failed to assign driver" });
  }
}

async function unassignDriver(req, res) {
  try {
    const orderId = req.params.id;

    const order = await getOrderById(orderId, req.storeId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const updatedOrder = await unassignDriverFromOrder(orderId, req.storeId);
    return res.json(updatedOrder);
  } catch (error) {
    console.error("Error unassigning driver:", error);
    return res.status(500).json({ error: "Failed to unassign driver" });
  }
}

async function changeOrderStatus(req, res) {
  try {
    const orderId = req.params.id;
    const { status } = req.body;

    const validStatuses = [
      "PENDING", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED",
    ];

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const order = await getOrderById(orderId, req.storeId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (
      (status === "PICKED_UP" || status === "OUT_FOR_DELIVERY" || status === "DELIVERED") &&
      !order.assigned_driver_id
    ) {
      return res.status(400).json({
        error: "Cannot update status to PICKED_UP, OUT_FOR_DELIVERY, or DELIVERED without assigning a driver first",
      });
    }

    const updatedOrder = await updateOrderStatus(orderId, status, req.storeId);
    return res.json(updatedOrder);
  } catch (error) {
    console.error("Error updating order status:", error);
    return res.status(500).json({ error: "Failed to update order status" });
  }
}

async function setCustomerLocation(req, res) {
  try {
    const orderId = req.params.id;
    const { mapLink } = req.body;

    if (!mapLink) {
      return res.status(400).json({ error: "mapLink is required" });
    }

    const coords = await parseMapLink(mapLink);
    if (!coords) {
      return res.status(422).json({
        error: "Could not extract coordinates from that link. Make sure it's a valid Google Maps link.",
      });
    }

    const order = await getOrderById(orderId, req.storeId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    await updateCustomerLocation(orderId, coords.lat, coords.lng, req.storeId);
    return res.json({ lat: coords.lat, lng: coords.lng });
  } catch (error) {
    console.error("Error setting customer location:", error);
    return res.status(500).json({ error: "Failed to set customer location" });
  }
}

module.exports = { getOrders, assignDriver, unassignDriver, changeOrderStatus, setCustomerLocation };
