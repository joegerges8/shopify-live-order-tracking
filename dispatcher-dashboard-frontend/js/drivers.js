import { getDrivers, getOrders, deleteDriver } from "./api.js";
import { showToast, confirmAction } from "./ui.js";

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
          <td colspan="6">No drivers found.</td>
        </tr>
      `;
      return;
    }

    drivers.forEach((driver) => {
      const row = document.createElement("tr");
      const driverStatus = isDriverBusy(driver.id, orders) ? "ASSIGNED" : "AVAILABLE";

      // data-label repeats the column heading inside the cell, for the phone
      // layout where each driver becomes a card and the header row is gone.
      row.innerHTML = `
        <td data-label="ID">${driver.id ?? ""}</td>
        <td data-label="Full Name">${driver.full_name ?? ""}</td>
        <td data-label="Phone">${driver.phone ?? ""}</td>
        <td data-label="Status">${createStatusBadge(driverStatus)}</td>
        <td data-label="Performance">
          <button class="btn-secondary" data-performance="${driver.id}">
            Check Performance
          </button>
        </td>
        <td data-label="Actions">
          <button class="btn-delete" data-id="${driver.id}">Delete</button>
        </td>
      `;

      // Opens the Performance page already narrowed to this driver, rather
      // than reproducing the figures in this row. The settlement maths, the
      // date range and the per-order breakdown all live there, and a second
      // copy of them here is a second chance to disagree about someone's pay.
      row
        .querySelector("[data-performance]")
        .addEventListener("click", () => {
          window.location.href = `performance.html?driver=${driver.id}`;
        });

      row.querySelector(".btn-delete").addEventListener("click", async () => {
        // Deleting a driver is not undoable from the dashboard, so it keeps a
        // confirmation step — an in-page modal now, not the browser's.
        const confirmed = await confirmAction({
          title: `Delete driver "${driver.full_name}"?`,
          message: "They will lose access to the driver app. This cannot be undone.",
          confirmLabel: "Delete driver",
          danger: true,
        });
        if (!confirmed) return;

        try {
          await deleteDriver(driver.id);
          row.remove();
          showToast(`Driver "${driver.full_name}" deleted.`, "success");
        } catch (err) {
          showToast("Failed to delete driver. Please try again.", "error");
          console.error(err);
        }
      });

      tableBody.appendChild(row);
    });
  } catch (error) {
    console.error("Error loading drivers:", error);
    tableBody.innerHTML = `
      <tr>
        <td colspan="6">Failed to load drivers.</td>
      </tr>
    `;
  }
}

loadDrivers();