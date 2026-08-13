import { getOrders, getDrivers, assignDriver, unassignDriver, updateOrderStatus, updateOrderArea, getAreas, importOrders, deleteOrder, markOrderPaid } from "./api.js";
import { showToast, confirmAction } from "./ui.js";

const tableBody = document.querySelector("#ordersTable tbody");

const totalOrdersEl = document.getElementById("totalOrders");
const unfulfilledOrdersEl = document.getElementById("unfulfilledOrders");
const inProgressOrdersEl = document.getElementById("inProgressOrders");
const deliveredOrdersEl = document.getElementById("deliveredOrders");
const availableDriversEl = document.getElementById("availableDrivers");

const searchOrderEl = document.getElementById("searchOrder");
const searchPhoneEl = document.getElementById("searchPhone");
const statusFilterEl = document.getElementById("statusFilter");
const cityFilterEl = document.getElementById("cityFilter");
const areaFilterEl = document.getElementById("areaFilter");

let allOrders = [];
let allDrivers = [];
// Populated once from GET /orders/areas; used for the per-row override picker.
let allAreas = [];
let unknownArea = "Other";

function getCustomerName(order) {
  return (
    order.customer_name ||
    `${order.customer_first_name ?? ""} ${order.customer_last_name ?? ""}`.trim()
  );
}

function getOrderCity(order) {
  return order.display_city || order.city || "";
}

// The delivery area (caza) the backend derived from the city, or the unknown
// bucket for orders whose city string could not be placed.
function getOrderArea(order) {
  return order.area || unknownArea;
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

// The WhatsApp glyph, inlined so it renders without a network request and
// takes its colour from the button label.
const WHATSAPP_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>`;

// Matches on digits alone so the search works however the number was typed or
// stored — +961 3 719 871, 03 719 871 and 3719871 all find the same customer.
function phoneMatches(order, queryDigits) {
  if (!queryDigits) return true;

  const stored = String(order.customer_phone ?? "").replace(/\D/g, "");
  if (!stored) return false;
  if (stored.includes(queryDigits)) return true;

  // Local numbers are stored with their country code, so a search starting
  // with the trunk 0 still has to reach them: 03719871 -> 9613719871.
  const withoutTrunk = queryDigits.replace(/^0+/, "");
  return withoutTrunk.length > 0 && stored.includes(withoutTrunk);
}

function createPhoneCell(order) {
  const phone = order.customer_phone;
  const waNumber = toWhatsAppNumber(phone);
  if (!waNumber) return "—";

  return `<a class="small-btn phone-btn" href="https://wa.me/${waNumber}"
             target="_blank" rel="noopener noreferrer"
             title="Message ${escapeHtml(phone)} on WhatsApp">${WHATSAPP_ICON}<span>${escapeHtml(phone)}</span></a>`;
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
  CREATED:          "Unfulfilled",
  PENDING:          "Unfulfilled",
  UNFULFILLED:      "Unfulfilled",
  ASSIGNED:         "Assigned",
  PICKED_UP:        "Picked Up",
  OUT_FOR_DELIVERY: "OUT FOR DELIVERY",
  DELIVERED:        "Delivered",
  RETURNED:         "Returned",
  FULFILLED:        "Fulfilled",
  CANCELLED:        "Cancelled",
  PAID:             "Mark as Paid",
  DELETED:          "Deleted",
};

function normalizeOrderStatus(status) {
  return ["CREATED", "PENDING"].includes(status) || !status ? "UNFULFILLED" : status;
}

function createStatusOptions(currentStatus) {
  const normalizedCurrentStatus = normalizeOrderStatus(currentStatus);
  // Dispatcher's preferred order. PAID and DELETED are not delivery statuses:
  // PAID records payment and leaves the delivery status alone, DELETED removes
  // the order outright.
  const statuses = [
    "ASSIGNED",   // Assigned
    "PICKED_UP",  // Picked Up
    "UNFULFILLED", // Unfulfilled
    "CANCELLED",  // Cancelled
    "DELETED",    // Deleted
    "RETURNED",   // Returned by the driver
    "DELIVERED",  // Delivered
    "PAID",       // Mark as Paid
  ];

  let options = `<option value="">Select status</option>`;

  statuses.forEach((status) => {
    const selected = status === normalizedCurrentStatus ? "selected" : "";
    options += `<option value="${status}" ${selected}>${STATUS_DISPLAY[status] || status}</option>`;
  });

  return options;
}

function createStatusBadge(status) {
  status = normalizeOrderStatus(status);
  const normalized = status.toLowerCase();
  const display = STATUS_DISPLAY[status] || status;
  return `<span class="status-badge status-${normalized}">${display}</span>`;
}

/* ===========================
   STATS
=========================== */

// Which orders are out with a driver right now. This is the delivery
// lifecycle, a separate axis from Shopify's fulfillment status — an assigned
// order counts here and is still Unfulfilled in Shopify.
const IN_PROGRESS_STATUSES = ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"];

// Shopify's own fulfillment status, mirrored into the orders table by the
// webhooks and the importer. Anything short of a complete fulfillment —
// null, "partial", "restocked" — is still unfulfilled in the Shopify admin.
function isFulfilledInShopify(order) {
  return String(order.fulfillment_status || "").toLowerCase() === "fulfilled";
}

function updateStats(orders, drivers) {
  const totalOrders = orders.length;
  // Read straight from Shopify's fulfillment status rather than inferred from
  // the local delivery status, so this card always matches the number the
  // Unfulfilled filter shows in the Shopify admin.
  const unfulfilledOrders = orders.filter((order) => !isFulfilledInShopify(order)).length;
  const inProgressOrders = orders.filter((order) =>
    IN_PROGRESS_STATUSES.includes(normalizeOrderStatus(order.order_status))
  ).length;
  const deliveredOrders = orders.filter((order) => order.order_status === "DELIVERED").length;
  const availableDrivers = drivers.filter((driver) => !isDriverBusy(driver.id, orders)).length;

  totalOrdersEl.textContent = totalOrders;
  unfulfilledOrdersEl.textContent = unfulfilledOrders;
  inProgressOrdersEl.textContent = inProgressOrders;
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

// Only areas that actually have orders appear in the filter, so the dropdown
// stays short even though the backend knows all 26 cazas.
function populateAreaFilter(orders) {
  if (!areaFilterEl) return;

  const previous = areaFilterEl.value;
  const uniqueAreas = [...new Set(orders.map(getOrderArea).filter(Boolean))].sort();

  areaFilterEl.innerHTML = `<option value="">All areas</option>`;
  uniqueAreas.forEach((area) => {
    const option = document.createElement("option");
    option.value = area;
    option.textContent = area;
    areaFilterEl.appendChild(option);
  });

  // Keep the dispatcher's selection across refreshes.
  if (uniqueAreas.includes(previous)) areaFilterEl.value = previous;
}

// Options for a row's area override picker, with the order's current area
// preselected.
function createAreaOptions(currentArea) {
  const options = [...allAreas, unknownArea];
  return options
    .map((area) => {
      const selected = area === currentArea ? "selected" : "";
      return `<option value="${area}" ${selected}>${area}</option>`;
    })
    .join("");
}

function applyFilters() {
  const searchValue = searchOrderEl.value.trim().toLowerCase();
  const phoneQuery = searchPhoneEl.value.replace(/\D/g, "");
  const selectedStatus = statusFilterEl.value;
  const selectedCity = cityFilterEl.value;
  const selectedArea = areaFilterEl ? areaFilterEl.value : "";

  const filteredOrders = allOrders.filter((order) => {
    const orderNumber = String(order.order_number ?? "").toLowerCase();
    const orderStatus = normalizeOrderStatus(order.order_status);
    const city = getOrderCity(order);
    const area = getOrderArea(order);

    const matchesSearch = !searchValue || orderNumber.includes(searchValue);
    const matchesPhone = phoneMatches(order, phoneQuery);
    const matchesStatus = !selectedStatus || orderStatus === selectedStatus;
    const matchesCity = !selectedCity || city === selectedCity;
    const matchesArea = !selectedArea || area === selectedArea;

    return matchesSearch && matchesPhone && matchesStatus && matchesCity && matchesArea;
  });

  renderOrders(filteredOrders, allDrivers);
}

/* ===========================
   RENDER
=========================== */

/* ===========================
   DRIVER NOTES
=========================== */

// Which notes the dispatcher has opened, by order id. The table re-renders on
// its own every 30 seconds, and without this an open note would snap shut
// mid-read each time.
const expandedNoteOrderIds = new Set();

function getDriverNote(order) {
  return String(order.driver_note ?? "").trim();
}

// The toggle that sits in the order's row. Rendered only for orders whose
// driver actually wrote something, so a dispatcher scanning the table sees a
// note marker exactly where there is a note and nothing anywhere else.
function createDriverNoteToggle(order) {
  if (!getDriverNote(order)) return "";

  const isOpen = expandedNoteOrderIds.has(String(order.id));
  return `<button class="small-btn note-btn" type="button"
             data-note-order-id="${order.id}" aria-expanded="${isOpen}"
             title="Show the driver's note">📝 Note<span class="note-caret">${isOpen ? "▲" : "▼"}</span></button>`;
}

// The note itself — "nobody home, tried 3pm", "gate code 4412" — as a
// full-width row under the order it belongs to. It stays collapsed until the
// dispatcher opens it, so the table keeps one line per order, and it is a row
// rather than a column because free text needs the width and a column would be
// blank for almost every order.
//
// Returns null when the driver has written nothing, and the order then renders
// exactly as it did before.
function createDriverNoteRow(order) {
  const note = getDriverNote(order);
  if (!note) return null;

  const row = document.createElement("tr");
  row.className = "driver-note-row";
  row.id = `driver-note-${order.id}`;
  row.hidden = !expandedNoteOrderIds.has(String(order.id));
  // The note is text a driver typed, so it is escaped rather than trusted as
  // markup, and its line breaks are kept by the stylesheet's pre-wrap.
  row.innerHTML =
    `<td colspan="10"><div class="driver-note-cell">` +
    `<span class="driver-note-label">Driver note</span>` +
    `<span class="driver-note-text">${escapeHtml(note)}</span>` +
    `</div></td>`;
  return row;
}

function toggleDriverNote(button) {
  const orderId = button.getAttribute("data-note-order-id");
  const row = document.getElementById(`driver-note-${orderId}`);
  if (!row) return;

  const isOpen = !row.hidden;
  row.hidden = isOpen;
  button.setAttribute("aria-expanded", String(!isOpen));

  const caret = button.querySelector(".note-caret");
  if (caret) caret.textContent = isOpen ? "▼" : "▲";

  if (isOpen) expandedNoteOrderIds.delete(orderId);
  else expandedNoteOrderIds.add(orderId);
}

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

    const orderStatus = normalizeOrderStatus(order.order_status);

    const trackingBtn = order.tracking_token && orderStatus !== "UNFULFILLED"
      ? `<a class="small-btn track-btn" href="/track/track.html?token=${encodeURIComponent(order.tracking_token)}"
             target="_blank" rel="noopener noreferrer"
             title="Open the customer's tracking page">🔗 Track</a>`
      : "";

    // An assigned order offers only Unassign. The driver picker and Assign
    // button come back once the order is free again, so assigning is a
    // one-step action rather than something that can be silently redone.
    const assignControls = order.assigned_driver_id
      ? `<button class="small-btn danger-btn" data-unassign-order-id="${order.id}">Unassign</button>`
      : `<select id="driver-${order.id}">
           ${createDriverOptions(drivers, allOrders, order.assigned_driver_id)}
         </select>
         <button class="small-btn" data-assign-order-id="${order.id}">Assign</button>`;

    // data-label carries the column heading down into the cell itself. On a
    // phone the table is restacked into one card per order, where there is no
    // header row left to read a value against, and the stylesheet prints these
    // as the label beside each value.
    row.innerHTML = `
      <td data-label="Order #">
        ${order.order_number ?? ""}
        ${createDriverNoteToggle(order)}
      </td>
      <td data-label="Customer">${customerName}</td>
      <td data-label="Phone">${createPhoneCell(order)}</td>
      <td data-label="City">
        ${city}
        <div class="area-cell">
          <select id="area-${order.id}" class="area-select">${createAreaOptions(getOrderArea(order))}</select>
          <button class="small-btn" data-area-order-id="${order.id}">Set</button>
        </div>
      </td>
      <td data-label="Total">${order.total_price ?? ""}</td>
      <td data-label="Financial Status">${order.financial_status ?? ""}</td>
      <td data-label="Order Status">${createStatusBadge(orderStatus)}</td>
      <td data-label="Assigned Driver">${assignedDriverName}</td>
      <td data-label="Assign Driver">
        <div class="action-group">
          ${assignControls}
          ${trackingBtn}
        </div>
      </td>
      <td data-label="Update Status">
        <div class="action-group">
          <select id="status-${order.id}">
            ${createStatusOptions(orderStatus)}
          </select>
          <button class="small-btn" data-status-order-id="${order.id}" data-order-number="${order.order_number || ""}" data-has-driver="${order.assigned_driver_id ? "1" : "0"}">Update</button>
        </div>
      </td>
    `;

    tableBody.appendChild(row);

    const driverNoteRow = createDriverNoteRow(order);
    if (driverNoteRow) tableBody.appendChild(driverNoteRow);
  });

  attachEventListeners();
}

/* ===========================
   LOAD DATA
=========================== */

// Loads the area list once per page load. A failure here is not fatal: the
// filter still works off the areas present in the orders, only the per-row
// override picker would be empty.
async function loadAreas() {
  if (allAreas.length) return;
  try {
    const data = await getAreas();
    if (Array.isArray(data.areas)) allAreas = data.areas;
    if (data.unknown) unknownArea = data.unknown;
  } catch (error) {
    console.error("Error loading areas:", error);
  }
}

async function loadOrders() {
  try {
    await loadAreas();
    const [orders, drivers] = await Promise.all([getOrders(), getDrivers()]);

    allOrders = orders;
    allDrivers = drivers;

    updateStats(orders, drivers);
    populateCityFilter(orders);
    populateAreaFilter(orders);
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

function attachEventListeners() {
  const assignButtons = document.querySelectorAll("[data-assign-order-id]");
  const unassignButtons = document.querySelectorAll("[data-unassign-order-id]");
  const statusButtons = document.querySelectorAll("[data-status-order-id]");
  const areaButtons = document.querySelectorAll("[data-area-order-id]");
  const noteButtons = document.querySelectorAll("[data-note-order-id]");

  noteButtons.forEach((button) => {
    button.addEventListener("click", () => toggleDriverNote(button));
  });

  areaButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const orderId = button.getAttribute("data-area-order-id");
      const areaSelect = document.getElementById(`area-${orderId}`);
      if (!areaSelect) return;

      try {
        await updateOrderArea(orderId, areaSelect.value);
        await loadOrders();
      } catch (error) {
        showToast(`Failed to update area: ${error.message}`, "error");
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
        showToast("Please select a driver.", "error");
        return;
      }

      try {
        await assignDriver(orderId, Number(driverId));
        showToast("Driver assigned.", "success");
        await loadOrders();
      } catch (error) {
        console.error("Error assigning driver:", error);
        showToast("Failed to assign driver.", "error");
      }
    });
  });

  unassignButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const orderId = button.getAttribute("data-unassign-order-id");

      try {
        await unassignDriver(orderId);
        showToast("Driver unassigned.", "success");
        await loadOrders();
      } catch (error) {
        console.error("Error unassigning driver:", error);
        showToast("Failed to unassign driver.", "error");
      }
    });
  });

  statusButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const orderId = button.getAttribute("data-status-order-id");
      const statusSelect = document.getElementById(`status-${orderId}`);
      const status = statusSelect.value;

      if (!status) {
        showToast("Please select a status.", "error");
        return;
      }

      // Paying and deleting still stop to ask — they reach into Shopify and
      // neither can be taken back by picking a different status afterwards.
      // The prompt is now an in-page modal rather than the browser's.
      if (status === "PAID") {
        const orderLabel = button.getAttribute("data-order-number") || `#${orderId}`;
        const confirmed = await confirmAction({
          title: `Mark order ${orderLabel} as paid?`,
          message:
            "This records a payment in Shopify. Undoing it means issuing a refund.\n\n" +
            "The delivery status stays as it is.",
          confirmLabel: "Mark as paid",
        });
        if (!confirmed) return;

        button.disabled = true;
        try {
          await markOrderPaid(orderId);
          showToast(
            `Order ${orderLabel} is now marked as paid in Shopify and the dashboard.`,
            "success"
          );
          await loadOrders();
        } catch (error) {
          console.error("Error marking order as paid:", error);
          showToast(`Could not mark the order as paid:\n${error.message}`, "error");
        } finally {
          button.disabled = false;
        }
        return;
      }

      if (status === "DELETED") {
        const orderLabel = button.getAttribute("data-order-number") || `#${orderId}`;
        const confirmed = await confirmAction({
          title: `Permanently delete order ${orderLabel}?`,
          message:
            "It will be removed from this dashboard AND from Shopify.\n\n" +
            "This cannot be undone.",
          confirmLabel: "Delete order",
          danger: true,
        });
        if (!confirmed) return;

        button.disabled = true;
        try {
          await deleteOrder(orderId);
          showToast(
            `Order ${orderLabel} was deleted from Shopify and the dashboard.`,
            "success"
          );
          await loadOrders();
        } catch (error) {
          console.error("Error deleting order:", error);
          showToast(`Could not delete the order:\n${error.message}`, "error");
          button.disabled = false;
        }
        return;
      }

      // Delivering fulfills the order in Shopify and records the cash payment,
      // so it belongs with paying and deleting: worth stopping to ask, since
      // picking a different status afterwards will not undo either.
      if (status === "DELIVERED") {
        const orderLabel = button.getAttribute("data-order-number") || `#${orderId}`;
        const hasDriver = button.getAttribute("data-has-driver") === "1";
        const confirmed = await confirmAction({
          title: `Mark order ${orderLabel} as delivered?`,
          message:
            "This fulfills the order in Shopify and records payment for cash orders.\n\n" +
            (hasDriver
              ? ""
              : "No driver is assigned to this order — it will be closed out without one.\n\n") +
            "Undoing the payment means issuing a refund.",
          confirmLabel: "Mark as delivered",
        });
        if (!confirmed) return;
      }

      try {
        const updated = await updateOrderStatus(orderId, status);
        if (updated && updated.shopify_warning) {
          showToast(
            `Status updated to ${status}, but Shopify was not updated:\n${updated.shopify_warning}`,
            "error"
          );
        } else if (status === "CANCELLED") {
          showToast(
            "Order cancelled in Shopify and the driver was unassigned.\n" +
            "It has been removed from this dashboard.",
            "success"
          );
        } else {
          showToast(`Status updated to ${status}.`, "success");
        }
        await loadOrders();
      } catch (error) {
        console.error("Error updating status:", error);
        showToast(`Failed to update status: ${error.message}`, "error");
      }
    });
  });
}

/* ===========================
   INIT
=========================== */

searchOrderEl.addEventListener("input", applyFilters);
searchPhoneEl.addEventListener("input", applyFilters);
statusFilterEl.addEventListener("change", applyFilters);
cityFilterEl.addEventListener("change", applyFilters);
if (areaFilterEl) areaFilterEl.addEventListener("change", applyFilters);

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
