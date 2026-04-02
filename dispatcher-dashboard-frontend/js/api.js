const BASE_URL = "http://localhost:3000/api";

export async function getOrders() {
  const response = await fetch(`${BASE_URL}/orders`);
  if (!response.ok) {
    throw new Error("Failed to fetch orders");
  }
  return response.json();
}

export async function getDrivers() {
  const response = await fetch(`${BASE_URL}/drivers`);
  if (!response.ok) {
    throw new Error("Failed to fetch drivers");
  }
  return response.json();
}

export async function createDriver(driverData) {
  const response = await fetch(`${BASE_URL}/drivers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(driverData),
  });

  if (!response.ok) {
    throw new Error("Failed to create driver");
  }

  return response.json();
}

export async function assignDriver(orderId, driverId) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/assign-driver`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ driverId }),
  });

  if (!response.ok) {
    throw new Error("Failed to assign driver");
  }

  return response.json();
}

export async function updateOrderStatus(orderId, status) {
  const response = await fetch(`${BASE_URL}/orders/${orderId}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    throw new Error("Failed to update status");
  }

  return response.json();
}


