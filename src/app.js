//import libraries
//import Express framework (HTTP requests, routing, middleware,  responses)
const express = require("express");

//Cross-Origin Resource Sharing, allows frontend apps to communicate with the backend.
const cors = require("cors");

//Helmet adds security headers to HTTP responses.
const helmet = require("helmet");

//Morgan logs incoming HTTP requests.
const morgan = require("morgan");

const webhookRoutes = require("./routes/webhookRoutes");
const orderRoutes = require("./routes/orderRoutes");
const driverRoutes = require("./routes/driverRoutes");
//Create the Express application instance. This is the main app object that we will configure with middleware and routes.
const app = express();

//
// For normal JSON routes
//JSON middleware parses incoming JSON request bodies and makes them available under req.body. This is essential for handling API requests that send data in JSON format.
//This tells Express to parse JSON request bodies for /api routes. We use a separate route for webhooks that requires raw body parsing, so we only apply this middleware to the /api routes.
console.log("webhookRoutes:", webhookRoutes, typeof webhookRoutes);
console.log("orderRoutes:", orderRoutes, typeof orderRoutes);
console.log("cors:", typeof cors());
console.log("helmet:", typeof helmet());
console.log("morgan:", typeof morgan("dev"));
console.log("express.json:", typeof express.json());
app.use("/api", express.json());

//
//Enable CORS, set security headers with Helmet, and log requests with Morgan.
//For Shopify embedded apps, we need to allow the app to be rendered
//inside an iframe on admin.shopify.com / *.myshopify.com, so we disable
//Helmet's default frameguard header (X-Frame-Options: SAMEORIGIN).
app.use(cors());
app.use(
   helmet({
      frameguard: false,
   })
);
app.use(morgan("dev"));

// Simple landing + health endpoints (useful for Railway/browser checks)
app.get("/", (req, res) => {
   res.status(200).type("text").send("OK");
});

app.get("/health", (req, res) => {
   res.status(200).json({ status: "ok" });
});

// Shopify webhook route needs raw body for HMAC verification
app.use("/webhooks/shopify", webhookRoutes);


console.log("orderRoutes =", orderRoutes);
console.log("typeof orderRoutes =", typeof orderRoutes);
// Normal API routes
//This sets up the routes for handling API requests related to orders. Any request to /api/orders will be handled by the orderRoutes router, which we imported at the top of the file.
app.use("/api/orders", orderRoutes);
app.use("/api/drivers", driverRoutes);
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