# Live Tracking Implementation — Socket.io + Uber-Style UI

## Overview

### The Problem
The original customer tracking page polled the server every **10 seconds** with a plain HTTP `fetch`. This meant:
- Location updates could be up to 10 seconds stale
- Every customer tab was hammering the server with repeated requests
- The UI was a basic status card with a blue dot on a map — nothing engaging

### What Was Built
- **Real-time push** via Socket.io — when the driver posts a GPS ping, it arrives at the customer's browser in milliseconds, not up to 10 seconds later
- **Uber-style UI** — full-screen map, rotating car SVG marker, live route polyline, ETA countdown, 4-step progress bar, pulsing LIVE badge

### Technologies Used
| Technology | Why |
|---|---|
| **Socket.io** | WebSocket-first with automatic HTTP long-poll fallback; single npm install; works on Railway out of the box |
| **Google Maps DirectionsService** | Client-side route + ETA calculation; no extra API keys; same key already used for the map |
| **SVG data URLs** | Rotating car icon without a canvas or extra image files; regenerated on each bearing change |

---

## Backend — Socket.io

### New file: `src/socket.js`

```js
let _io = null;

function init(httpServer) {
  const { Server } = require('socket.io');
  _io = new Server(httpServer, { cors: { origin: '*' } });

  _io.on('connection', (socket) => {
    const { token } = socket.handshake.query;
    if (token) socket.join(`order:${token}`);
  });

  return _io;
}

function getIO() { return _io; }
module.exports = { init, getIO };
```

**Key design decisions:**

- **Singleton pattern.** `init()` is called once at startup; everywhere else in the codebase calls `getIO()` to get the same instance without passing it around as a parameter.

- **Room per order.** When a customer browser connects, it passes `?token=<tracking_token>` in the WebSocket handshake. The server joins that socket to the room named `order:{token}`. This means when the driver's location update arrives, we only broadcast to the one customer watching that specific order — not everyone.

- **Token = room key.** The tracking token is already the public credential for an order (it's what's in the customer's URL). Reusing it as the room name keeps things simple and avoids a separate lookup.

---

### Changed: `src/server.js`

**Before:**
```js
app.listen(PORT, () => { ... });
```

**After:**
```js
const http = require("http");
const { init: initSocket } = require("./socket");

const server = http.createServer(app);
initSocket(server);
server.listen(PORT, () => { ... });
```

**Why the change?** Socket.io attaches itself to the raw Node.js `http.Server` object so it can intercept the HTTP `Upgrade` request that upgrades a normal HTTP connection to a WebSocket. `app.listen()` creates an `http.Server` internally but throws it away — you can't attach Socket.io to it after the fact. Creating the server explicitly with `http.createServer(app)` gives you that handle.

---

### Changed: `src/controllers/driverSelfController.js`

Two places were updated — each saves to the database first, then fires the socket event.

**Location update (`postMyOrderLocation`):**
```js
const created = await createLocationUpdate({ order_id, driver_id, latitude, longitude });

const io = getIO();
if (io && order.tracking_token) {
  io.to(`order:${order.tracking_token}`).emit("location_update", {
    latitude,
    longitude,
    updated_at: created.created_at,
  });
}
```

**Status change (`patchMyOrderStatus`):**
```js
const updated = await updateOrderStatus(orderId, status);

const io = getIO();
if (io && order.tracking_token) {
  io.to(`order:${order.tracking_token}`).emit("status_update", { status });
}
```

**Why DB first, then emit?** If the emit happens before the DB write, a customer who refreshes immediately after (or whose fallback poll fires) would fetch stale data from the DB. Write first, then tell the browser the truth.

**How does the controller get `tracking_token`?** The existing `getOrderById(orderId)` call (which was already there for the ownership check) does `SELECT *` — so `order.tracking_token` is already on the object. No extra query needed.

---

### Changed: `src/app.js` — Content Security Policy

```js
scriptSrc: [
  ...,
  "https://cdn.socket.io",   // ← allow loading socket.io client from CDN
],
connectSrc: [
  ...,
  "wss:",                    // ← allow WebSocket connections (Railway uses wss://)
  "ws:",                     // ← allow WebSocket connections (localhost dev uses ws://)
],
```

Without `wss:` in `connectSrc`, Helmet's CSP blocks the browser from opening the WebSocket connection and the socket silently falls back to HTTP polling.

---

## Frontend — Uber-Style UI (`customer-tracking-frontend/track.html`)

### Socket.io Client Connection

```js
socket = io(API_BASE, {
  query: { token },
  transports: ['websocket', 'polling'],
});

socket.on('location_update', ({ latitude, longitude, updated_at }) => {
  currentData.driver_location = { latitude, longitude, updated_at };
  applyMapData(currentData);   // move the car on the map
  fetchETA();                  // recalculate route + ETA
});

socket.on('status_update', ({ status }) => {
  currentData.order_status = status;
  applyCardData(currentData);  // update headline, steps, badge
  if (status === 'DELIVERED') cleanup();
});
```

The page also keeps a **30-second HTTP poll** as a safety net. If the WebSocket drops (bad mobile signal, server restart), the poll catches the customer up on missed state. When Socket.io is active the poll is slow (30s); without Socket.io it drops to 10s.

---

### Car SVG Marker with Rotation

Google Maps markers don't support CSS `transform: rotate()`. The workaround: regenerate the entire SVG string with the rotation baked into an SVG `<g transform="rotate(...)">` attribute, then set it as a `data:image/svg+xml` URL on the marker.

```js
function makeCarIcon(rotation) {
  const svg = `<svg xmlns="..." viewBox="0 0 48 48" width="48" height="48">
    <g transform="rotate(${rotation} 24 24)">
      <!-- top-down car body, windshields, wheels, lights -->
    </g>
  </svg>`;
  return {
    url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(48, 48),
    anchor:     new google.maps.Point(24, 24),  // pivot = center of icon
  };
}
```

**Bearing calculation** — the compass heading from the previous GPS position to the new one:

```js
function calcBearing(from, to) {
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const φ1   = from.lat * Math.PI / 180;
  const φ2   = to.lat  * Math.PI / 180;
  const y    = Math.sin(dLng) * Math.cos(φ2);
  const x    = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
```

On each location update: `calcBearing(prevPos, newPos)` → `marker.setIcon(makeCarIcon(bearing))`.

---

### Smooth Marker Animation

Instead of the car teleporting to each new GPS coordinate, it glides there:

```js
function animateMarker(marker, from, to, duration) {
  const start = performance.now();
  function step(now) {
    const t    = Math.min((now - start) / duration, 1);
    const ease = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;  // ease-in-out
    marker.setPosition({
      lat: from.lat + (to.lat - from.lat) * ease,
      lng: from.lng + (to.lng - from.lng) * ease,
    });
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
```

Duration is 1200ms — slightly longer than a typical GPS update interval so motion looks continuous rather than choppy.

---

### Route Polyline + ETA

The ETA is computed on the **server** (`src/services/etaService.js`) and arrives
at the page ready-made — in the `GET /api/track/:token` payload, then pushed on
the socket as `eta_update` after each GPS ping. The browser does no routing.

**Where the destination comes from.** Most orders have no customer coordinates:
`customer_latitude` is only filled when a Shopify note attribute or a
dispatcher-pasted map link supplies one. Rather than require that, the ETA
resolves the order's own `city` text to a town and looks that town's centre up
in `src/data/town-coords.json` (`src/utils/townCoords.js`). Against three years
of real orders this resolves 95% of them. The chain is:

| Tier | Source | Precision |
|---|---|---|
| 1 | `customer_latitude/longitude` — a real pin, when one exists | `EXACT` |
| 2 | town centre for the matched city text | `TOWN` |
| 3 | caza centroid from the `area` column | `AREA` |
| 4 | nothing resolvable | no ETA shown |

**The estimate.**

```
drive time (driver → destination)      # Directions with traffic, or a
                                       # distance-banded haversine fallback
+ ETA_HANDLING_SECONDS × stops ahead   # other orders the driver has started
+ ETA_LAST_MILE_SECONDS                # town centre → the actual door
floored at ETA_MIN_SECONDS
```

`stops ahead` counts the driver's other orders that are currently receiving GPS
pings (`countStartedDeliveries`). It deliberately assumes this customer is
served **last**: nothing records the order a driver works through a batch in, so
quoting late and arriving early is the safer error.

**Why a range.** A town centre is not a doorstep, so the page shows
`arriving 6:20 – 6:45 PM` rather than a single number. The window is ±15% for an
exact pin, ±25% for a town, ±40% for a caza, widened a further 5 points when the
driver has other stops.

**When it appears.** Two conditions must both hold: the dispatcher has marked
the order `PICKED_UP`, **and** the driver has tapped "Start Delivery" in the
driver app. That tap never reaches the backend, but it is what starts the GPS
stream — so a location ping newer than `ETA_START_WINDOW_SECONDS` is the signal
(`hasDriverStarted`), needing no app change or extra endpoint.

**Cost control.** Drivers ping every 15 s per order. `etaService` caches per
order and only re-routes when at least 60 s have passed *and* the driver has
moved more than 150 m. With no `GOOGLE_MAPS_SERVER_KEY` set at all it falls back
to straight-line distance × 1.3 at a distance-banded speed, so the feature works
before the key is configured.

The page draws the returned `polyline` with
`google.maps.geometry.encoding.decodePath` (hence `&libraries=geometry` on the
Maps script tag), and renders a translucent circle instead of the sharp green
dot when precision is `TOWN` or `AREA` — the map should not claim accuracy the
data does not have.

---

### Progress Steps Bar

4 steps: **Placed → Driver → Picked Up → Delivered**

```js
function stepIndex(status) {
  return {
    PENDING: 0, ASSIGNED: 1, PICKED_UP: 2,
    OUT_FOR_DELIVERY: 2, DELIVERED: 3, CANCELLED: 0,
  }[status] ?? 0;
}
```

Each dot gets a CSS class of `done`, `active`, or nothing:
- `done` — black filled circle with a `✓`
- `active` — black filled with a glow ring (current step)
- (none) — grey outline (future step)

Connector lines between dots are filled black when both endpoints are done.

---

### Status-Aware Map Behavior

| Status | Car on map | Route drawn | ETA shown | Live badge |
|---|---|---|---|---|
| PENDING | No | No | No | No |
| ASSIGNED | No | No | No | No |
| PICKED_UP | Yes | Yes | Yes¹ | Yes |
| OUT_FOR_DELIVERY | Yes | Yes | Yes¹ | Yes |
| DELIVERED | No (removed) | No (hidden) | No | No |
| CANCELLED | No | No | No | No |

¹ Only once the driver has also tapped "Start Delivery" — i.e. GPS is actively
flowing for this order. An order marked `PICKED_UP` that is still sitting in the
shop shows the car and badge but no time.

---

## Full Data Flow

```
Driver App                   Backend (Node.js)           Customer Browser
    │                               │                           │
    │  POST /api/drivers/me/        │                           │
    │       orders/:id/location     │                           │
    │  { latitude, longitude }      │                           │
    │──────────────────────────────>│                           │
    │                               │  1. INSERT location_updates│
    │                               │  2. getIO()               │
    │                               │     .to('order:TOKEN')    │
    │                               │     .emit('location_update')
    │                               │──────────────────────────>│
    │                               │                           │ applyMapData()
    │                               │                           │ animateMarker()
    │                               │                           │ fetchETA() (if 30s passed)
    │                               │                           │
    │  PATCH /api/drivers/me/       │                           │
    │        orders/:id/status      │                           │
    │  { status: "PICKED_UP" }      │                           │
    │──────────────────────────────>│                           │
    │                               │  1. UPDATE orders         │
    │                               │  2. getIO()               │
    │                               │     .to('order:TOKEN')    │
    │                               │     .emit('status_update')│
    │                               │──────────────────────────>│
    │                               │                           │ applyCardData()
    │                               │                           │ updateProgressSteps()
    │                               │                           │ car marker appears
    │                               │                           │ route line draws
```

---

## Files Changed at a Glance

| File | Change |
|---|---|
| `src/socket.js` | **New** — Socket.io singleton, room-per-order logic |
| `src/server.js` | `app.listen` → `http.createServer` + `initSocket` |
| `src/app.js` | CSP: added `cdn.socket.io` to scriptSrc, `wss:` / `ws:` to connectSrc |
| `src/controllers/driverSelfController.js` | Emit `location_update` after GPS save; emit `status_update` after status change |
| `customer-tracking-frontend/track.html` | Full rewrite — Uber-style UI with Socket.io, car SVG, route, ETA, progress steps |
| `package.json` / `package-lock.json` | Added `socket.io` dependency |

---

## How to Test

1. Start the server: `npm run dev`
2. Open the tracking URL in a browser: `https://<host>/track/track.html?token=<valid_token>`
3. Open **DevTools → Network → WS tab** — you should see an active WebSocket connection
4. Simulate a driver GPS ping:
   ```bash
   curl -X POST https://<host>/api/drivers/me/orders/<id>/location \
     -H "Authorization: Bearer <driver_jwt>" \
     -H "Content-Type: application/json" \
     -d '{"latitude": 33.8938, "longitude": 35.5018}'
   ```
   The car should appear and animate on the map **instantly** — no page refresh needed.
5. Change status to PICKED_UP:
   ```bash
   curl -X PATCH https://<host>/api/drivers/me/orders/<id>/status \
     -H "Authorization: Bearer <driver_jwt>" \
     -H "Content-Type: application/json" \
     -d '{"status": "PICKED_UP"}'
   ```
   The progress bar and headline should update immediately on the tracking page.
