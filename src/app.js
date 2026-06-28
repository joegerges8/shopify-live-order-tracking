//import libraries
//import Express framework (HTTP requests, routing, middleware,  responses)
const express = require("express");

const path = require("path");

//Cross-Origin Resource Sharing, allows frontend apps to communicate with the backend.
const cors = require("cors");

//Helmet adds security headers to HTTP responses.
const helmet = require("helmet");

//Morgan logs incoming HTTP requests.
const morgan = require("morgan");

const webhookRoutes = require("./routes/webhookRoutes");
const orderRoutes = require("./routes/orderRoutes");
const driverRoutes = require("./routes/driverRoutes");
const mapsRoutes = require("./routes/mapsRoutes");
const trackingRoutes = require("./routes/trackingRoutes");
const adminRoutes = require("./routes/adminRoutes");
const launchRoutes = require("./routes/launchRoutes");
const authRoutes = require("./routes/authRoutes");
const { setupPassword } = require("./controllers/authController");
const requireAdminAuth = require("./middleware/requireAdminAuth");
//Create the Express application instance. This is the main app object that we will configure with middleware and routes.
const app = express();

//
// For normal JSON routes
//JSON middleware parses incoming JSON request bodies and makes them available under req.body. This is essential for handling API requests that send data in JSON format.
//This tells Express to parse JSON request bodies for /api routes. We use a separate route for webhooks that requires raw body parsing, so we only apply this middleware to the /api routes.
app.use("/api", express.json());

//
//Enable CORS, set security headers with Helmet, and log requests with Morgan.
app.use(cors());
app.use(
   helmet({
      frameguard: { action: "deny" },
      contentSecurityPolicy: {
         directives: {
            defaultSrc: ["'self'"],
            frameAncestors: ["'none'"],
            scriptSrc: [
               "'self'",
               "'unsafe-inline'",
               "https://maps.googleapis.com",
               "https://maps.gstatic.com",
               "https://cdn.socket.io",
            ],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: [
               "'self'",
               "data:",
               "https://maps.googleapis.com",
               "https://maps.gstatic.com",
               "https://maps.google.com",
               "https://*.google.com",
               "https://*.googleapis.com",
               "https://*.gstatic.com",
            ],
            connectSrc: [
               "'self'",
               "https://maps.googleapis.com",
               "https://*.googleapis.com",
               "https://*.gstatic.com",
               "wss:",
               "ws:",
            ],
            fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
         },
      },
   })
);
app.use(morgan("dev"));

// Serve dispatcher dashboard static frontend from the same Railway domain.
// Visit: https://<your-railway-domain>/dashboard/
const dashboardDir = path.join(__dirname, "../dispatcher-dashboard-frontend");
app.use("/dashboard", express.static(dashboardDir));

// Shopify OAuth — initiates install flow for any store
app.use("/auth", authRoutes);

// Password setup after first OAuth install
app.post("/api/admin/setup-password", express.json(), setupPassword);

// Shopify app launch URL — Shopify navigates here when merchant clicks the app
app.use("/launch", launchRoutes);

// Simple landing + health endpoints (useful for Railway/browser checks)
app.get("/", (req, res) => {
   res.status(200).type("text").send("OK");
});

app.get("/health", (req, res) => {
   res.status(200).json({ status: "ok" });
});


app.get("/privacy", (req, res) => {
   res.status(200).type("html").send(`
      <!DOCTYPE html>
      <html>
      <head>
         <meta charset="UTF-8" />
         <meta name="viewport" content="width=device-width, initial-scale=1.0" />
         <title>LiveDispatch Privacy Policy</title>
         <style>
            body {
               font-family: Arial, sans-serif;
               max-width: 850px;
               margin: 40px auto;
               padding: 0 20px;
               line-height: 1.6;
               color: #222;
            }
            h1, h2 { color: #111; }
         </style>
      </head>
      <body>
         <h1>LiveDispatch Privacy Policy</h1>
         <p>Last updated: June 23, 2026</p>

         <h2>Information We Collect</h2>
         <p>LiveDispatch collects store and order information needed to provide delivery dispatching, driver assignment, and customer order tracking services. This may include order details, customer name, delivery address, phone number, email address, order status, tracking links, and driver assignment information.</p>

         <h2>How We Use Information</h2>
         <p>We use this information to import orders, assign drivers, update delivery statuses, display dispatcher dashboards, and provide customers with real-time delivery tracking pages.</p>

         <h2>Data Sharing</h2>
         <p>We do not sell merchant or customer data. Data is only used to provide the LiveDispatch service and may be processed by hosting, database, and infrastructure providers required to operate the app.</p>

         <h2>Data Storage and Security</h2>
         <p>LiveDispatch stores app data securely and uses reasonable technical measures to protect merchant and customer information.</p>

         <h2>Data Retention and Deletion</h2>
         <p>Merchants may request deletion of their store data by contacting support. When a store uninstalls the app, LiveDispatch may delete or anonymize related data according to applicable requirements.</p>

         <h2>Contact</h2>
         <p>For privacy questions or data deletion requests, contact us at: gergesjoe.2004@gmail.com</p>
      </body>
      </html>
   `);
});


// Shopify webhook route needs raw body for HMAC verification
app.use("/webhooks/shopify", webhookRoutes);

// Normal API routes
app.use("/api/admin", adminRoutes);
app.use("/api/orders", requireAdminAuth, orderRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/maps", mapsRoutes);
app.use("/api/track", trackingRoutes);

// Serve customer tracking page at /track/
const trackingDir = path.join(__dirname, "../customer-tracking-frontend");
app.use("/track", express.static(trackingDir));
//Export the configured Express app so it can be used by the server (e.g., in server.js).
//This allows server.js to import the Express application and start the server.
module.exports = app;


/**
 * 
 *Application Structure:
server.js
   ↓
app.js
   ↓
routes
   ↓
controllers
   ↓
services
   ↓
database

*/
