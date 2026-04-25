import { getOrders, getDrivers, assignDriver, unassignDriver, updateOrderStatus } from "./api.js";

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

function createStatusOptions(currentStatus) {
  const statuses = [
    "PENDING",
    "ASSIGNED",
    "PICKED_UP",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED",
  ];

  let options = `<option value="">Select status</option>`;

  statuses.forEach((status) => {
    const selected = status === currentStatus ? "selected" : "";
    options += `<option value="${status}" ${selected}>${status}</option>`;
  });

  return options;
}

function createStatusBadge(status) {
  if (!status) return "";
  const normalized = status.toLowerCase();
  return `<span class="status-badge status-${normalized}">${status}</span>`;
}

/* ===========================
   STATS
=========================== */

function updateStats(orders, drivers) {
  const totalOrders = orders.length;
  const pendingOrders = orders.filter((order) => order.order_status === "PENDING").length;
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
  const uniqueCities = [...new Set(orders.map((order) => order.city).filter(Boolean))];

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
    const city = order.city ?? "";

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
        <td colspan="9">No orders found.</td>
      </tr>
    `;
    return;
  }

  orders.forEach((order) => {
    const row = document.createElement("tr");
    const assignedDriverName = getDriverNameById(order.assigned_driver_id, drivers);

    row.innerHTML = `
      <td>${order.order_number ?? ""}</td>
      <td>${order.customer_first_name ?? ""} ${order.customer_last_name ?? ""}</td>
      <td>${order.city ?? ""}</td>
      <td>${order.total_price ?? ""}</td>
      <td>${order.financial_status ?? ""}</td>
      <td>${createStatusBadge(order.order_status)}</td>
      <td>${assignedDriverName}</td>
      <td>
        <div class="action-group">
          <select id="driver-${order.id}">
            ${createDriverOptions(drivers, allOrders, order.assigned_driver_id)}
          </select>
          <button class="small-btn" data-assign-order-id="${order.id}">Assign</button>
          ${
            order.assigned_driver_id
              ? `<button class="small-btn danger-btn" data-unassign-order-id="${order.id}">Unassign</button>`
              : ""
          }
        </div>
      </td>
      <td>
        <div class="action-group">
          <select id="status-${order.id}">
            ${createStatusOptions(order.order_status)}
          </select>
          <button class="small-btn" data-status-order-id="${order.id}">Update</button>
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
        <td colspan="9">Failed to load orders.</td>
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

  assignButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const orderId = button.getAttribute("data-assign-order-id");
      const driverSelect = document.getElementById(`driver-${orderId}`);
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

      try {
        await updateOrderStatus(orderId, status);
        alert("Status updated successfully.");
        await loadOrders();
      } catch (error) {
        console.error("Error updating status:", error);
        alert("Failed to update status.");
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

loadOrders();

// Auto-refresh every 30 seconds so dispatchers see status changes
// pushed by the driver app (PICKED_UP, DELIVERED) without a manual page reload.
setInterval(loadOrders, 30_000);