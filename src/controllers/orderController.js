const {
  getAllOrders,
  getOrderById,
  assignDriverToOrder,
  unassignDriverFromOrder,
  updateOrderStatus,
  markOrderPaid,
  deleteOrderEverywhere,
  updateCustomerLocation,
  updateOrderArea,
} = require("../services/orderService");
const { AREAS, UNKNOWN_AREA } = require("../utils/areaLookup");
const { parseMapLink } = require("../utils/parseMapLink");
const { importOrdersFromShopify } = require("../services/shopifyService");
const { getIO, emitToDispatch } = require("../socket");
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

    // An order an outside carrier is already shipping is not ours to hand to a
    // driver — the parcel is with Wakilni, not at the counter. The dashboard
    // hides the picker for these orders; this is the same rule where it counts.
    if (order.carrier_tracking_url) {
      return res.status(400).json({
        error:
          `This order is being delivered by ${order.carrier_name || "an outside carrier"}, ` +
          `so it cannot be assigned to a driver.`,
      });
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
    const requestedStatus = req.body?.status;
    const status = requestedStatus === "PENDING" ? "UNFULFILLED" : requestedStatus;

    const validStatuses = [
      "UNFULFILLED", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED", "FULFILLED", "CANCELLED",
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

    // PICKED_UP and OUT_FOR_DELIVERY describe a driver carrying the order, so
    // they still need one named. DELIVERED does not: orders get handed over at
    // the counter, dropped off by the owner, or delivered by someone who was
    // never entered in the app, and the dispatcher still has to close them out.
    if (
      (status === "PICKED_UP" || status === "OUT_FOR_DELIVERY") &&
      !order.assigned_driver_id
    ) {
      return res.status(400).json({
        error: "Cannot update status to PICKED_UP or OUT_FOR_DELIVERY without assigning a driver first",
      });
    }

    const updatedOrder = await updateOrderStatus(orderId, status, req.storeId);

    // A status set from the dashboard has to travel as far as one set from the
    // driver's phone. It did not: the driver app's path pushed to both the
    // customer's tracking page and the live map, while this one pushed to
    // nothing, so a dispatcher marking an order PICKED_UP saw their own map
    // and the customer's page sit unchanged until something happened to
    // re-poll them.
    const io = getIO();
    if (io && updatedOrder && updatedOrder.tracking_token) {
      io.to(`order:${updatedOrder.tracking_token}`).emit("status_update", { status });
    }

    // Cancelling releases the driver, so the updated row has no driver id to
    // read — but the map is showing that driver holding this order right now
    // and is precisely who needs telling. The pre-update row still knows.
    const affectedDriverId =
      updatedOrder?.assigned_driver_id ?? order.assigned_driver_id;

    if (updatedOrder && affectedDriverId) {
      emitToDispatch(req.storeId, "driver_status", {
        driver_id: affectedDriverId,
        order: {
          id: updatedOrder.id,
          order_number: updatedOrder.order_number,
          order_status: status,
        },
      });
    }

    return res.json(updatedOrder);
  } catch (error) {
    console.error("Error updating order status:", error);
    return res.status(500).json({ error: "Failed to update order status" });
  }
}

// The list of areas the dispatcher can pick from. Served from the backend so
// the dashboard dropdown and the validation above can never drift apart.
function listAreas(req, res) {
  return res.json({ areas: AREAS, unknown: UNKNOWN_AREA });
}

// Lets the dispatcher correct an order's area from the dashboard. The lookup
// classifies ~96% of orders on its own; this covers the rest — unrecognized
// city strings that landed in 'Other', and the occasional wrong guess — without
// waiting for a backend deploy.
async function changeOrderArea(req, res) {
  try {
    const orderId = req.params.id;
    const { area } = req.body || {};

    if (!area) {
      return res.status(400).json({ error: "area is required" });
    }

    // Only a known area or the explicit unknown bucket. Free text here would
    // fragment the filter chips in the driver app.
    if (area !== UNKNOWN_AREA && !AREAS.includes(area)) {
      return res.status(400).json({ error: "Invalid area value" });
    }

    const updated = await updateOrderArea(orderId, area, req.storeId);
    if (!updated) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.json(updated);
  } catch (error) {
    console.error("Error updating order area:", error);
    return res.status(500).json({ error: "Failed to update order area" });
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

// Records payment for an order in Shopify and mirrors it locally. The delivery
// status is untouched — this only moves the order off "Payment pending".
async function payOrder(req, res) {
  try {
    const updated = await markOrderPaid(req.params.id, req.storeId);
    if (!updated) {
      return res.status(404).json({ error: "Order not found" });
    }
    return res.json(updated);
  } catch (error) {
    console.error("Error marking order as paid:", error);
    return res.status(502).json({ error: error.message || "Failed to mark the order as paid" });
  }
}

// Permanently removes an order from Shopify and the dashboard. Shopify only
// allows this for some orders, so a refusal is reported verbatim and nothing
// is deleted locally.
async function removeOrder(req, res) {
  try {
    const order = await getOrderById(req.params.id, req.storeId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    await deleteOrderEverywhere(req.params.id, req.storeId);
    return res.json({ deleted: true, order_number: order.order_number });
  } catch (error) {
    console.error("Error deleting order:", error);
    return res.status(502).json({ error: error.message || "Failed to delete order" });
  }
}

// Pulls the store's Shopify order history into the dashboard on demand. The
// real failure reason is returned to the caller so the dispatcher can see why
// a sync came back empty instead of having to read server logs.
async function importOrders(req, res) {
  try {
    const result = await importOrdersFromShopify(req.storeId);
    return res.json(result);
  } catch (error) {
    console.error("Error importing orders from Shopify:", error);
    return res.status(502).json({ error: error.message || "Failed to import orders from Shopify" });
  }
}

module.exports = {
  getOrders,
  assignDriver,
  unassignDriver,
  changeOrderStatus,
  changeOrderArea,
  listAreas,
  setCustomerLocation,
  importOrders,
  payOrder,
  removeOrder,
};
