import { getOrders, getDrivers, assignDriver, unassignDriver, updateOrderStatus, setCustomerLocation, importOrders, deleteOrder, markOrderPaid } from "./api.js";

const tableBody = document.querySelector("#ordersTable tbody");

const totalOrdersEl = document.getElementById("totalOrders");
const pendingOrdersEl = document.getElementById("pendingOrders");
const deliveredOrdersEl = document.getElementById("deliveredOrders");
const availableDriversEl = document.getElementById("availableDrivers");

const searchOrderEl = document.getElementById("searchOrder");
const statusFilterEl = document.getElementById("statusFilter");
const cityFilterEl = document.getElementById("cityFilter");

let allOrders = [];
let allDrivers = [];

function getCustomerName(order) {
  return (
    order.customer_name ||
    `${order.customer_first_name ?? ""} ${order.customer_last_name ?? ""}`.trim()
  );
}

function getOrderCity(order) {
  return order.display_city || order.city || "";
}

/* ===========================
   CUSTOMER PHONE / WHATSAPP
=========================== */

// Country code assumed for numbers stored in local form (03 719 871).
const DEFAULT_COUNTRY_CODE = "961"; // Lebanon

// wa.me wants digits only, including the country code and without a leading +.
function toWhatsAppNumber(rawPhone) {
  if (!rawPhone) return null;

  const trimmed = String(rawPhone).trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  // Already international: +961…
  if (trimmed.startsWith("+")) return digits;
  // Dialling prefix instead of a plus: 00961…
  if (digits.startsWith("00")) return digits.slice(2);
  // Local form, the leading 0 is dropped when the country code goes on.
  if (digits.startsWith("0")) return DEFAULT_COUNTRY_CODE + digits.slice(1);
  // Bare number that already carries the country code.
  if (digits.startsWith(DEFAULT_COUNTRY_CODE)) return digits;

  return DEFAULT_COUNTRY_CODE + digits;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createPhoneCell(order) {
  const phone = order.customer_phone;
  const waNumber = toWhatsAppNumber(phone);
  if (!waNumber) return "—";

  return `<a class="small-btn phone-btn" href="https://wa.me/${waNumber}"
             target="_blank" rel="noopener noreferrer"
             title="Message ${escapeHtml(phone)} on WhatsApp">💬 ${escapeHtml(phone)}</a>`;
}

/* ===========================
   DRIVER LOGIC
=========================== */

function getDriverActiveOrders(driverId, orders) {
  return orders.filter(
    (order) =>
      Number(order.assigned_driver_id) === Number(driverId) &&
      !["DELIVERED", "CANCELLED"].includes(order.order_status)
  );
}

function isDriverBusy(driverId, orders) {
  return getDriverActiveOrders(driverId, orders).length > 0;
}

function getDriverNameById(driverId, drivers) {
  if (!driverId) return "Not assigned";

  const driver = drivers.find((d) => Number(d.id) === Number(driverId));
  return driver ? driver.full_name : `Driver #${driverId}`;
}

function createDriverOptions(drivers, orders, selectedDriverId = null) {
  let options = `<option value="">Select driver</option>`;

  drivers.forEach((driver) => {
    const activeOrders = getDriverActiveOrders(driver.id, orders);
    const activeCount = activeOrders.length;

    const isSelected = Number(driver.id) === Number(selectedDriverId);

    let label = `${driver.full_name} (Available)`;

    if (activeCount > 0) {
      label = `${driver.full_name} (Assigned to ${activeCount} order${activeCount > 1 ? "s" : ""})`;
    }

    options += `<option value="${driver.id}" ${isSelected ? "selected" : ""}>${label}</option>`;
  });

  return options;
}

/* ===========================
   STATUS + UI
=========================== */

const STATUS_DISPLAY = {
  PENDING:          "UNFULFILLED",
  ASSIGNED:         "ASSIGNED",
  PICKED_UP:        "PICKED_UP",
  OUT_FOR_DELIVERY: "OUT FOR DELIVERY",
  DELIVERED:        "DELIVERED",
  FULFILLED:        "FULFILLED",
  CANCELLED:        "CANCELLED",
  PAID:             "MARK AS PAID",
  DELETED:          "DELETE ORDER",
};

function createStatusOptions(currentStatus) {
  const statuses = [
    "PENDING",
    "ASSIGNED",
    "PICKED_UP",
    "DELIVERED",
    "FULFILLED",
    "CANCELLED",
    // Neither of these is a delivery status. PAID records payment and leaves
    // the delivery status alone; DELETED removes the order outright.
    "PAID",
    "DELETED",
  ];

  let options = `<option value="">Select status</option>`;

  statuses.forEach((status) => {
    const selected = status === currentStatus ? "selected" : "";
    options += `<option value="${status}" ${selected}>${STATUS_DISPLAY[status] || status}</option>`;
  });

  return options;
}

function createStatusBadge(status) {
  if (!status) return "";
  const normalized = status.toLowerCase();
  const display = STATUS_DISPLAY[status] || status;
  return `<span class="status-badge status-${normalized}">${display}</span>`;
}

/* ===========================
   STATS
=========================== */

function updateStats(orders, drivers) {
  const totalOrders = orders.length;
  const pendingOrders = orders.filter((order) =>
    !["DELIVERED", "FULFILLED", "CANCELLED"].includes(order.order_status)
  ).length;
  const deliveredOrders = orders.filter((order) => order.order_status === "DELIVERED").length;
  const availableDrivers = drivers.filter((driver) => !isDriverBusy(driver.id, orders)).length;

  totalOrdersEl.textContent = totalOrders;
  pendingOrdersEl.textContent = pendingOrders;
  deliveredOrdersEl.textContent = deliveredOrders;
  availableDriversEl.textContent = availableDrivers;
}

/* ===========================
   FILTERS
=========================== */

function populateCityFilter(orders) {
  const uniqueCities = [...new Set(orders.map(getOrderCity).filter(Boolean))];

  cityFilterEl.innerHTML = `<option value="">All cities</option>`;

  uniqueCities.sort().forEach((city) => {
    const option = document.createElement("option");
    option.value = city;
    option.textContent = city;
    cityFilterEl.appendChild(option);
  });
}

function applyFilters() {
  const searchValue = searchOrderEl.value.trim().toLowerCase();
  const selectedStatus = statusFilterEl.value;
  const selectedCity = cityFilterEl.value;

  const filteredOrders = allOrders.filter((order) => {
    const orderNumber = String(order.order_number ?? "").toLowerCase();
    const orderStatus = order.order_status ?? "";
    const city = getOrderCity(order);

    const matchesSearch = !searchValue || orderNumber.includes(searchValue);
    const matchesStatus = !selectedStatus || orderStatus === selectedStatus;
    const matchesCity = !selectedCity || city === selectedCity;

    return matchesSearch && matchesStatus && matchesCity;
  });

  renderOrders(filteredOrders, allDrivers);
}

/* ===========================
   RENDER
=========================== */

function renderOrders(orders, drivers) {
  tableBody.innerHTML = "";

  if (!orders || orders.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10">No orders found.</td>
      </tr>
    `;
    return;
  }

  orders.forEach((order) => {
    const row = document.createElement("tr");
    const assignedDriverName = getDriverNameById(order.assigned_driver_id, drivers);
    const customerName = getCustomerName(order);
    const city = getOrderCity(order);

    const trackingBtn = order.tracking_token && order.order_status !== "PENDING"
      ? `<button class="small-btn track-btn" data-tracking-token="${order.tracking_token}" title="Copy tracking link">🔗 Track</button>`
      : "";

    const locationLabel = order.customer_latitude ? "📍 Update Location" : "📍 Set Location";
    const locationBtn = `<button class="small-btn" data-location-order-id="${order.id}">${locationLabel}</button>`;

    // An assigned order offers only Unassign. The driver picker and Assign
    // button come back once the order is free again, so assigning is a
    // one-step action rather than something that can be silently redone.
    const assignControls = order.assigned_driver_id
      ? `<button class="small-btn danger-btn" data-unassign-order-id="${order.id}">Unassign</button>`
      : `<select id="driver-${order.id}">
           ${createDriverOptions(drivers, allOrders, order.assigned_driver_id)}
         </select>
         <button class="small-btn" data-assign-order-id="${order.id}">Assign</button>`;

    row.innerHTML = `
      <td>${order.order_number ?? ""}</td>
      <td>${customerName}</td>
      <td>${createPhoneCell(order)}</td>
      <td>${city}</td>
      <td>${order.total_price ?? ""}</td>
      <td>${order.financial_status ?? ""}</td>
      <td>${createStatusBadge(order.order_status)}</td>
      <td>${assignedDriverName}</td>
      <td>
        <div class="action-group">
          ${assignControls}
          ${trackingBtn}
          ${locationBtn}
        </div>
      </td>
      <td>
        <div class="action-group">
          <select id="status-${order.id}">
            ${createStatusOptions(order.order_status)}
          </select>
          <button class="small-btn" data-status-order-id="${order.id}" data-order-number="${order.order_number || ""}">Update</button>
        </div>
      </td>
    `;

    tableBody.appendChild(row);
  });

  attachEventListeners();
}

/* ===========================
   LOAD DATA
=========================== */

async function loadOrders() {
  try {
    const [orders, drivers] = await Promise.all([getOrders(), getDrivers()]);

    allOrders = orders;
    allDrivers = drivers;

    updateStats(orders, drivers);
    populateCityFilter(orders);
    applyFilters();
  } catch (error) {
    console.error("Error loading orders:", error);
    tableBody.innerHTML = `
      <tr>
        <td colspan="10">Failed to load orders.</td>
      </tr>
    `;
  }
}

/* ===========================
   EVENTS
=========================== */

function copyTrackingLink(token) {
  const url = `${window.location.origin}/track/track.html?token=${token}`;
  navigator.clipboard.writeText(url).then(() => {
    alert("Tracking link copied! Send it to the customer.");
  }).catch(() => {
    prompt("Copy this tracking link:", url);
  });
}

function attachEventListeners() {
  const assignButtons = document.querySelectorAll("[data-assign-order-id]");
  const unassignButtons = document.querySelectorAll("[data-unassign-order-id]");
  const statusButtons = document.querySelectorAll("[data-status-order-id]");
  const trackButtons = document.querySelectorAll("[data-tracking-token]");
  const locationButtons = document.querySelectorAll("[data-location-order-id]");

  trackButtons.forEach((button) => {
    button.addEventListener("click", () => {
      copyTrackingLink(button.getAttribute("data-tracking-token"));
    });
  });

  locationButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const orderId = button.getAttribute("data-location-order-id");
      const mapLink = prompt("Paste the customer's Google Maps link\nor raw coordinates (e.g. 33.94861, 35.67228):");

      if (!mapLink || !mapLink.trim()) return;

      button.textContent = "Saving...";
      button.disabled = true;

      try {
        const result = await setCustomerLocation(orderId, mapLink.trim());
        button.textContent = "📍 Update Location";
        button.disabled = false;
        alert(`Location saved! (${result.lat.toFixed(5)}, ${result.lng.toFixed(5)})`);
      } catch (error) {
        button.textContent = "📍 Set Location";
        button.disabled = false;
        alert(`Error: ${error.message}`);
      }
    });
  });

  assignButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const orderId = button.getAttribute("data-assign-order-id");
      const driverSelect = document.getElementById(`driver-${orderId}`);
      // The picker is only rendered for unassigned orders; if a refresh removed
      // it mid-click there is nothing to assign.
      if (!driverSelect) return;
      const driverId = driverSelect.value;

      if (!driverId) {
        alert("Please select a driver.");
        return;
      }

      try {
        await assignDriver(orderId, Number(driverId));
        alert("Driver assigned successfully.");
        await loadOrders();
      } catch (error) {
        console.error("Error assigning driver:", error);
        alert("Failed to assign driver.");
      }
    });
  });

  unassignButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const orderId = button.getAttribute("data-unassign-order-id");

      try {
        await unassignDriver(orderId);
        alert("Driver unassigned successfully.");
        await loadOrders();
      } catch (error) {
        console.error("Error unassigning driver:", error);
        alert("Failed to unassign driver.");
      }
    });
  });

  statusButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const orderId = button.getAttribute("data-status-order-id");
      const statusSelect = document.getElementById(`status-${orderId}`);
      const status = statusSelect.value;

      if (!status) {
        alert("Please select a status.");
        return;
      }

      if (status === "PAID") {
        const orderLabel = button.getAttribute("data-order-number") || `#${orderId}`;
        const confirmed = confirm(
          `Mark order ${orderLabel} as paid?\n\n` +
          `This records a payment in Shopify. Undoing it means issuing a refund. ` +
          `The delivery status stays as it is.`
        );
        if (!confirmed) return;

        button.disabled = true;
        try {
          await markOrderPaid(orderId);
          alert(`Order ${orderLabel} is now marked as paid in Shopify and the dashboard.`);
          await loadOrders();
        } catch (error) {
          console.error("Error marking order as paid:", error);
          alert(`Could not mark the order as paid:\n\n${error.message}`);
        } finally {
          button.disabled = false;
        }
        return;
      }

      if (status === "DELETED") {
        const orderLabel = button.getAttribute("data-order-number") || `#${orderId}`;
        const confirmed = confirm(
          `Permanently delete order ${orderLabel}?\n\n` +
          `It will be removed from this dashboard AND from Shopify. ` +
          `This cannot be undone.`
        );
        if (!confirmed) return;

        button.disabled = true;
        try {
          await deleteOrder(orderId);
          alert(`Order ${orderLabel} was deleted from Shopify and the dashboard.`);
          await loadOrders();
        } catch (error) {
          console.error("Error deleting order:", error);
          alert(`Could not delete the order:\n\n${error.message}`);
          button.disabled = false;
        }
        return;
      }

      try {
        const updated = await updateOrderStatus(orderId, status);
        if (updated && updated.shopify_warning) {
          alert(`Status updated to ${status}, but Shopify was not updated:\n\n${updated.shopify_warning}`);
        } else if (status === "CANCELLED") {
          alert(
            "Order cancelled in Shopify and the driver was unassigned.\n\n" +
            "It has been removed from this dashboard. The order is still in Shopify."
          );
        } else {
          alert("Status updated successfully.");
        }
        await loadOrders();
      } catch (error) {
        console.error("Error updating status:", error);
        alert(`Failed to update status: ${error.message}`);
      }
    });
  });
}

/* ===========================
   INIT
=========================== */

searchOrderEl.addEventListener("input", applyFilters);
statusFilterEl.addEventListener("change", applyFilters);
cityFilterEl.addEventListener("change", applyFilters);

const syncOrdersBtn = document.getElementById("syncOrdersBtn");
const syncStatusEl = document.getElementById("syncStatus");

if (syncOrdersBtn) {
  syncOrdersBtn.addEventListener("click", async () => {
    syncOrdersBtn.disabled = true;
    syncStatusEl.className = "sync-status";
    syncStatusEl.textContent = "Syncing orders from Shopify…";

    try {
      const result = await importOrders();
      await loadOrders();
      syncStatusEl.className = "sync-status sync-ok";
      syncStatusEl.textContent =
        `Synced ${result.imported} of ${result.fetched} orders from Shopify.` +
        (result.failed ? ` ${result.failed} could not be saved.` : "");
    } catch (error) {
      syncStatusEl.className = "sync-status sync-error";
      syncStatusEl.textContent = `Sync failed: ${error.message}`;
    } finally {
      syncOrdersBtn.disabled = false;
    }
  });
}

loadOrders();

// Auto-refresh every 30 seconds so dispatchers see status changes
// pushed by the driver app (PICKED_UP, DELIVERED) without a manual page reload.
setInterval(loadOrders, 30_000);
