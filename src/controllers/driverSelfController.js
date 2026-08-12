// driverSelfController.js
//
// Handles HTTP requests for the driver's own data: orders, location updates,
// and status changes. Every route in this controller is protected by the
// requireDriverAuth middleware, which verifies the JWT token in the
// Authorization header and attaches the driver's ID to req.driverId.

const {
  getOrdersByDriverId,
  getCompletedOrdersByDriverId,
  getReturnedOrdersByDriverId,
  getOrderByIdForDriver,
  updateDriverOrderStatus,
  updateDriverOrderNote,
  createLocationUpdate,
  markOrderPaid,
} = require("../services/orderService");
const { syncOrderTagToShopify, markDeliveredInShopify } = require("../services/shopifyService");
const { etaForTrackedOrder, clearEta } = require("../services/etaService");
const { getIO, emitToDispatch, emitToAllDispatch } = require("../socket");
const { updateDriverLocation } = require("../services/driverService");

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

// Returns all returned orders for the authenticated driver — what the app's
// Returned tab is rebuilt from after a restart.
async function getMyReturnedOrders(req, res) {
  try {
    const orders = await getReturnedOrdersByDriverId(req.driverId);
    return res.json(orders);
  } catch (error) {
    console.error("Error fetching returned orders:", error);
    return res.status(500).json({ error: "Failed to fetch returned orders" });
  }
}

// Records where the driver is, with no order attached.
//
// The per-order route below is what feeds the customer's tracking page, and it
// can only speak for a delivery that is already under way. This one answers
// the dispatcher's question instead — who is out there, right now, including
// the drivers standing free who are the ones worth giving the next order to.
// The driver app posts here for as long as it is running.
//
// Nothing about the customer's view is touched: no row is written to
// location_updates, so no tracking page gains a position it did not have.
async function postMyLocation(req, res) {
  try {
    const driverId = req.driverId;
    const { latitude, longitude } = req.body || {};

    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return res
        .status(400)
        .json({ error: "latitude and longitude must be numbers" });
    }

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({ error: "latitude or longitude out of range" });
    }

    const updated = await updateDriverLocation(driverId, latitude, longitude);
    if (!updated) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Straight to every open dashboard rather than to one store's room: a
    // position with no order attached belongs to no store in particular, and
    // drivers are shared across all of them.
    emitToAllDispatch("driver_location", {
      driver_id: driverId,
      latitude,
      longitude,
      updated_at: updated.last_location_at,
    });

    return res.status(201).json({
      latitude,
      longitude,
      updated_at: updated.last_location_at,
    });
  } catch (error) {
    console.error("Error recording driver location:", error);
    return res.status(500).json({ error: "Failed to record location" });
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

    const order = await getOrderByIdForDriver(orderId, driverId);
    if (!order) {
      return res.status(404).json({ error: "Order not found for this driver" });
    }

    const created = await createLocationUpdate({
      order_id: orderId,
      driver_id: driverId,
      latitude,
      longitude,
    });

    // The same fix, sent to the dispatcher's live map. It goes out before the
    // ETA work below so a Directions hiccup cannot delay the pin moving, and
    // it carries no lookup of its own — the map already knows the driver's
    // name from GET /api/drivers/locations and refetches if this id is new.
    emitToDispatch(order.store_id, "driver_location", {
      driver_id: driverId,
      latitude,
      longitude,
      updated_at: created.created_at,
      order: {
        id: order.id,
        order_number: order.order_number,
        order_status: order.order_status,
        city: order.city,
      },
    });

    const io = getIO();
    if (io && order.tracking_token) {
      const room = `order:${order.tracking_token}`;
      io.to(room).emit("location_update", {
        latitude,
        longitude,
        updated_at: created.created_at,
      });

      // Push a fresh ETA alongside the position so the customer's page updates
      // without polling. etaForTrackedOrder caches internally, so the pings
      // arriving every 15 seconds do not each cost a Directions call.
      //
      // Best-effort: a failed ETA must not fail the driver's location POST,
      // which is the thing that actually keeps the map alive.
      try {
        const eta = await etaForTrackedOrder({
          ...order,
          assigned_driver_id: driverId,
          driver_lat: latitude,
          driver_lng: longitude,
          // The ping was just written, so its age is zero by construction.
          location_age_seconds: 0,
        });
        if (eta) io.to(room).emit("eta_update", eta);
      } catch (error) {
        console.error("ETA push error:", error);
      }
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
      "ASSIGNED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "RETURNED",
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
      const order = await getOrderByIdForDriver(orderId, driverId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      return res.status(403).json({ error: "Not allowed for this order" });
    }

    // A finished order must not keep serving a cached countdown if its page is
    // reopened, and a status change can move an order in or out of the window
    // where an ETA is shown at all.
    if (["DELIVERED", "RETURNED", "CANCELLED"].includes(status)) {
      clearEta(orderId);
    }

    const io = getIO();
    if (io && updated.tracking_token) {
      io.to(`order:${updated.tracking_token}`).emit("status_update", { status });
    }

    // The live map labels each driver with what they are carrying, so a
    // delivery finishing has to reach it too — otherwise a driver sits on the
    // map marked "out for delivery" until the next poll.
    emitToDispatch(updated.store_id, "driver_status", {
      driver_id: driverId,
      order: {
        id: updated.id,
        order_number: updated.order_number,
        order_status: status,
      },
    });

    syncOrderTagToShopify(updated.store_id, updated.shopify_order_id, status, {
      driverName: updated.driver_name,
    }).catch(err =>
      console.error("[Shopify sync] driver status tag failed:", err.message)
    );
    if (status === "DELIVERED") {
      markDeliveredInShopify(updated.store_id, updated.shopify_order_id, updated).catch(err =>
        console.error("[Shopify sync] driver mark delivered failed:", err.message)
      );
      // The driver marking a delivery done is when cash on delivery is
      // collected, so record the payment in Shopify. A failure is logged
      // rather than shown to the driver — the dispatcher sees the order still
      // reading as unpaid on the dashboard and can mark it there.
      try {
        const paidRow = await markOrderPaid(updated.id, updated.store_id);
        if (paidRow) Object.assign(updated, paidRow);
      } catch (error) {
        console.error("[Shopify sync] driver mark paid failed:", error.message);
      }
    }

    return res.json(updated);
  } catch (error) {
    console.error("Error updating driver order status:", error);
    return res.status(500).json({ error: "Failed to update order status" });
  }
}

// The longest driver note the backend will store. Notes are typed on a phone
// and read on a phone, so this is generous rather than restrictive; it exists
// to stop a stuck key or a paste from filling the column.
const MAX_DRIVER_NOTE_LENGTH = 2000;

// Saves what the driver wrote about one of their own orders. This is the
// driver's own note — separate from orders.note, which mirrors the Shopify
// order note and is never written from the app.
async function patchMyOrderNote(req, res) {
  try {
    const orderId = Number(req.params.id);
    const driverId = req.driverId;
    const { note } = req.body || {};

    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    // null and "" both mean the driver cleared their note; anything that is
    // not a string at all is a malformed request rather than an empty note.
    if (note !== null && note !== undefined && typeof note !== "string") {
      return res.status(400).json({ error: "note must be a string" });
    }

    const trimmed = typeof note === "string" ? note.trim() : "";
    if (trimmed.length > MAX_DRIVER_NOTE_LENGTH) {
      return res
        .status(400)
        .json({ error: `note must be ${MAX_DRIVER_NOTE_LENGTH} characters or fewer` });
    }

    const updated = await updateDriverOrderNote(
      orderId,
      driverId,
      trimmed.length ? trimmed : null
    );

    // No row updated means the order does not exist or belongs to another
    // driver — the same split the status route makes.
    if (!updated) {
      const order = await getOrderByIdForDriver(orderId, driverId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      return res.status(403).json({ error: "Not allowed for this order" });
    }

    return res.json(updated);
  } catch (error) {
    console.error("Error updating driver order note:", error);
    return res.status(500).json({ error: "Failed to update note" });
  }
}

module.exports = {
  getMyOrders,
  getMyCompletedOrders,
  getMyReturnedOrders,
  postMyLocation,
  postMyOrderLocation,
  patchMyOrderStatus,
  patchMyOrderNote,
};
