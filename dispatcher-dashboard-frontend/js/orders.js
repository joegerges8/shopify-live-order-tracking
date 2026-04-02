import { getOrders } from "./api.js";

const tableBody = document.querySelector("#ordersTable tbody");

async function loadOrders() {
  try {
    const orders = await getOrders();

    console.log("Orders from backend:", orders);

    tableBody.innerHTML = "";

    orders.forEach((order) => {
      const row = document.createElement("tr");

      row.innerHTML = `
        <td>${order.order_number ?? ""}</td>
        <td>${order.customer_first_name ?? ""} ${order.customer_last_name ?? ""}</td>
        <td>${order.city ?? ""}</td>
        <td>${order.total_price ?? ""}</td>
        <td>${order.financial_status ?? ""}</td>
        <td>${order.order_status ?? ""}</td>
        <td>${order.assigned_driver_id ?? "Not assigned"}</td>
      `;

      tableBody.appendChild(row);
    });

    if (orders.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="7">No orders found.</td></tr>`;
    }
  } catch (error) {
    console.error("Error loading orders:", error);
    tableBody.innerHTML = `<tr><td colspan="7">Failed to load orders.</td></tr>`;
  }
}

loadOrders();