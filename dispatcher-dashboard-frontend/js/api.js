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

function handleResponse(response) {
  if (response.status === 401) {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminShop");
    window.location.replace("/dashboard/login.html");
    throw new Error("Session expired");
  }
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

export async function getOrders() {
  const response = await fetch(`${BASE_URL}/orders`, { headers: authHeaders() });
  return handleResponse(response);
}

export async function markOrderPaid(orderId) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/mark-paid`, {
    method: "PATCH",
    headers: authHeaders(),
  });
  if (response.status === 401) {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminShop");
    window.location.replace("/dashboard/login.html");
    throw new Error("Session expired");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

export async function deleteOrder(orderId) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (response.status === 401) {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminShop");
    window.location.replace("/dashboard/login.html");
    throw new Error("Session expired");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

export async function importOrders() {
  const response = await fetch(`${BASE_URL}/orders/import`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (response.status === 401) {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminShop");
    window.location.replace("/dashboard/login.html");
    throw new Error("Session expired");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

export async function getDrivers() {
  const response = await fetch(`${BASE_URL}/drivers`, { headers: authHeaders() });
  return handleResponse(response);
}

export async function assignDriver(orderId, driverId) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/assign-driver`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ driverId }),
  });
  return handleResponse(response);
}

export async function updateOrderStatus(orderId, status) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/status`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ status }),
  });
  if (response.status === 401) {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminShop");
    window.location.replace("/dashboard/login.html");
    throw new Error("Session expired");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

// Dispatcher override for an order's delivery area. The backend classifies
// most orders automatically from the city; this is the escape hatch for the
// ones it could not place.
export async function updateOrderArea(orderId, area) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/area`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ area }),
  });
  if (response.status === 401) {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminShop");
    window.location.replace("/dashboard/login.html");
    throw new Error("Session expired");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

// The canonical area list, served by the backend so the dropdown here and the
// validation there cannot drift apart.
export async function getAreas() {
  const response = await fetch(`${BASE_URL}/orders/areas`, {
    headers: authHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

// Dates are plain YYYY-MM-DD and are read as calendar days in the store's own
// timezone by the backend. Leaving them out is not the same as guessing them
// here: an omitted range means "today where the store is", which the browser
// cannot work out until the response tells it which timezone that is.
function rangeQuery({ from, to } = {}) {
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

// Every driver's deliveries, cash and pay for the range.
export async function getDriverPerformance(range) {
  const response = await fetch(
    `${BASE_URL}/drivers/performance${rangeQuery(range)}`,
    { headers: authHeaders() }
  );
  return handleResponse(response);
}

// The orders behind one driver's figures, for checking a number that looks off.
export async function getDriverPerformanceOrders(driverId, range) {
  const response = await fetch(
    `${BASE_URL}/drivers/${driverId}/performance${rangeQuery(range)}`,
    { headers: authHeaders() }
  );
  return handleResponse(response);
}

export async function deleteDriver(driverId) {
  const response = await fetch(`${BASE_URL}/drivers/${driverId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return handleResponse(response);
}

export async function unassignDriver(orderId) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/unassign-driver`, {
    method: "PATCH",
    headers: authHeaders(),
  });
  return handleResponse(response);
}

export async function setCustomerLocation(orderId, mapLink) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/customer-location`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ mapLink }),
  });
  if (response.status === 401) {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminShop");
    window.location.replace("/dashboard/login.html");
    throw new Error("Session expired");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to set customer location");
  return data;
}
