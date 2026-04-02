const bcrypt = require("bcryptjs");
const {
  getAllDrivers,
  getDriverByPhone,
  createDriver,
} = require("../services/driverService");

async function getDrivers(req, res) {
  try {
    const drivers = await getAllDrivers();
    return res.json(drivers);
  } catch (error) {
    console.error("Error fetching drivers:", error);
    return res.status(500).json({ error: "Failed to fetch drivers" });
  }
}

async function createNewDriver(req, res) {
  try {
    const { full_name, phone, password, status } = req.body;

    if (!full_name || !phone || !password) {
      return res.status(400).json({
        error: "full_name, phone, and password are required",
      });
    }

    const existingDriver = await getDriverByPhone(phone);

    if (existingDriver) {
      return res.status(409).json({
        error: "A driver with this phone already exists",
      });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const newDriver = await createDriver({
      full_name,
      phone,
      password_hash,
      status: status || "AVAILABLE",
    });

    return res.status(201).json(newDriver);
  } catch (error) {
    console.error("Error creating driver:", error);
    return res.status(500).json({ error: "Failed to create driver" });
  }
}

module.exports = {
  getDrivers,
  createNewDriver,
};