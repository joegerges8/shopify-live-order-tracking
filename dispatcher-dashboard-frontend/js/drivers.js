import { getDrivers } from "./api.js";

const tableBody = document.querySelector("#driversTable tbody");

async function loadDrivers() {
  try {
    const drivers = await getDrivers();
    console.log("Drivers from backend:", drivers);

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

      row.innerHTML = `
        <td>${driver.id ?? ""}</td>
        <td>${driver.full_name ?? ""}</td>
        <td>${driver.phone ?? ""}</td>
        <td>${driver.status ?? ""}</td>
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