// If served from Railway (recommended): use same-origin API.
// If opened as a local file (file://): fall back to your Railway API domain.
const FALLBACK_API_ORIGIN = "https://shopify-live-order-tracking-production.up.railway.app";
const API_ORIGIN = window.location.protocol === "file:" ? FALLBACK_API_ORIGIN : window.location.origin;
const BASE_URL = `${API_ORIGIN}/api`;

function authHeaders() {
  const token = localStorage.getItem("adminToken");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function getOrders() {
  const response = await fetch(`${BASE_URL}/orders`, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to fetch orders");
  return response.json();
}

export async function getDrivers() {
  const response = await fetch(`${BASE_URL}/drivers`, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to fetch drivers");
  return response.json();
}

export async function assignDriver(orderId, driverId) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/assign-driver`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ driverId }),
  });
  if (!response.ok) throw new Error("Failed to assign driver");
  return response.json();
}

export async function updateOrderStatus(orderId, status) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/status`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new Error("Failed to update status");
  return response.json();
}

export async function deleteDriver(driverId) {
  const response = await fetch(`${BASE_URL}/drivers/${driverId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error("Failed to delete driver");
  return response.json();
}

export async function unassignDriver(orderId) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/unassign-driver`, {
    method: "PATCH",
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error("Failed to unassign driver");
  return response.json();
}

export async function setCustomerLocation(orderId, mapLink) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/customer-location`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ mapLink }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to set customer location");
  return data;
}
