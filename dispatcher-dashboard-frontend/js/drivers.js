import { getDrivers, getOrders } from "./api.js";

const tableBody = document.querySelector("#driversTable tbody");

function isDriverBusy(driverId, orders) {
  return orders.some(
    (order) =>
      Number(order.assigned_driver_id) === Number(driverId) &&
      !["DELIVERED", "CANCELLED"].includes(order.order_status)
  );
}

function createStatusBadge(status) {
  if (!status) return "";
  const normalized = status.toLowerCase();
  return `<span class="status-badge status-${normalized}">${status}</span>`;
}

async function loadDrivers() {
  try {
    const [drivers, orders] = await Promise.all([getDrivers(), getOrders()]);
    console.log("Drivers from backend:", drivers);
    console.log("Orders from backend:", orders);

    tableBody.innerHTML = "";

    if (!drivers || drivers.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="4">No drivers found.</td>
        </tr>
      `;
      return;
    }

    drivers.forEach((driver) => {
      const row = document.createElement("tr");
      const driverStatus = isDriverBusy(driver.id, orders) ? "ASSIGNED" : "AVAILABLE";

      row.innerHTML = `
        <td>${driver.id ?? ""}</td>
        <td>${driver.full_name ?? ""}</td>
        <td>${driver.phone ?? ""}</td>
        <td>${createStatusBadge(driverStatus)}</td>
      `;

      tableBody.appendChild(row);
    });
  } catch (error) {
    console.error("Error loading drivers:", error);
    tableBody.innerHTML = `
      <tr>
        <td colspan="4">Failed to load drivers.</td>
      </tr>
    `;
  }
}

loadDrivers();