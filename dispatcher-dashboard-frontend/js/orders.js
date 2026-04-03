import { getOrders, getDrivers, assignDriver, updateOrderStatus } from "./api.js";

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

function getDriverNameById(driverId, drivers) {
  if (!driverId) return "Not assigned";

  const driver = drivers.find((d) => d.id === driverId);
  return driver ? driver.full_name : `Driver #${driverId}`;
}

function createDriverOptions(drivers, selectedDriverId = null) {
  let options = `<option value="">Select driver</option>`;

  drivers.forEach((driver) => {
    const selected = driver.id === selectedDriverId ? "selected" : "";
    options += `<option value="${driver.id}" ${selected}>${driver.full_name}</option>`;
  });

  return options;
}

function createStatusOptions(currentStatus) {
  const statuses = [
    "PENDING",
    "PICKED_UP",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED"
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

function updateStats(orders, drivers) {
  const totalOrders = orders.length;
  const pendingOrders = orders.filter((order) => order.order_status === "PENDING").length;
  const deliveredOrders = orders.filter((order) => order.order_status === "DELIVERED").length;
  const availableDrivers = drivers.filter((driver) => driver.status === "AVAILABLE").length;

  totalOrdersEl.textContent = totalOrders;
  pendingOrdersEl.textContent = pendingOrders;
  deliveredOrdersEl.textContent = deliveredOrders;
  availableDriversEl.textContent = availableDrivers;
}

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
            ${createDriverOptions(drivers, order.assigned_driver_id)}
          </select>
          <button class="small-btn" data-assign-order-id="${order.id}">Assign</button>
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

async function loadOrders() {
  try {
    const [orders, drivers] = await Promise.all([getOrders(), getDrivers()]);

    allOrders = orders;
    allDrivers = drivers;

    console.log("Orders:", orders);
    console.log("Drivers:", drivers);

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

function attachEventListeners() {
  const assignButtons = document.querySelectorAll("[data-assign-order-id]");
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

searchOrderEl.addEventListener("input", applyFilters);
statusFilterEl.addEventListener("change", applyFilters);
cityFilterEl.addEventListener("change", applyFilters);

loadOrders();