// Live Map — where every driver is, right now.
//
// The dispatcher's counterpart to the customer's tracking page. That page
// follows one driver towards one address; this one shows the whole fleet at
// once, so the question "who is nearest to this new order" can be answered by
// looking rather than by phoning round.
//
// Positions arrive two ways, and both are needed:
//
//   • The socket pushes each GPS fix the moment the driver's app files it,
//     which is what makes the pins move on their own.
//   • A slow poll re-reads the whole fleet every 20 seconds, which catches
//     drivers who came on shift, orders that changed hands, and anything the
//     socket missed while the laptop lid was shut.
//
// A driver only appears on the map while their app is sharing GPS — that is,
// during a delivery they have started. Drivers who are idle have no pin and no
// last position to show; they are listed on the left as offline instead, which
// is the honest rendering of "we do not know where they are".

import { getDriverLocations, API_ORIGIN } from "./api.js";
import { showToast } from "./ui.js";

// The same restricted browser key the customer tracking page uses — same
// Google project, same allowed origins.
const MAPS_BROWSER_KEY = "AIzaSyAriVJnIv8YZpcpQOIUy-4f3Tb1i0RTfAg";

// Safety net behind the socket, not the primary path.
const POLL_MS = 20_000;

// One ping to the next is ~15 seconds, so the pin is walked to its new spot
// over rather less than that: the marker should still be settling when the
// next fix lands, never sitting frozen waiting for it.
const MARKER_GLIDE_MS = 1200;

// Beirut. Only ever seen when the fleet has filed no GPS at all — the map
// needs some centre to open on before it has anything to fit.
const DEFAULT_CENTER = { lat: 33.8938, lng: 35.5018 };

const listEl = document.getElementById("driverList");
const countEl = document.getElementById("onlineCount");
const updatedEl = document.getElementById("mapUpdated");
const fallbackEl = document.getElementById("mapFallback");
const fitAllBtn = document.getElementById("fitAllBtn");

let map = null;
let drivers = [];              // last known fleet, in panel order
let markers = new Map();       // driver id → { marker, pos, bearing, frame }
let selectedId = null;         // the driver the map is following, if any
let pollTimer = null;
let refetchTimer = null;
let hasFitOnce = false;

/* ===========================
   Formatting
=========================== */

function initialsFor(name) {
  // Fed into an SVG marker, so anything that is not a plain letter or digit is
  // dropped rather than escaped — a name with an ampersand in it must not be
  // able to break the icon.
  const parts = String(name || "")
    .split(/\s+/)
    .map((part) => part.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean);

  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// How long ago the last fix was, in the words a dispatcher would use. The age
// is measured on the server at fetch time; between fetches it is nudged
// forward locally so a row does not keep claiming "live" while nothing arrives.
function agoText(seconds) {
  if (seconds == null) return "No location yet";
  if (seconds < 60) return "Live now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

// SCREAMING_SNAKE is how statuses are stored and how the orders table shows
// them, but here they sit inside a sentence in a 320px column — "Out for
// delivery" fits where "OUT_FOR_DELIVERY" would be cut in half.
function statusLabel(status) {
  const words = String(status || "").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ===========================
   Markers
=========================== */

// A pin in the shape of the answer: who it is and which way they are heading.
//
// Only drivers whose GPS is arriving right now get one, so there is a single
// colour and no stale state to draw. A pin on this map always means a driver
// being followed this minute.
const PIN_COLOUR = "#16a34a";

function markerIcon(initials, bearing) {
  // The arrow only means something when we know where they were going, which
  // takes two fixes; until then the pin is just the disc.
  const arrow =
    bearing == null
      ? ""
      : `<g transform="rotate(${bearing.toFixed(0)} 30 30)">
           <path d="M30 3 L36 14 L24 14 Z" fill="${PIN_COLOUR}"/>
         </g>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">` +
    `<circle cx="30" cy="30" r="27" fill="${PIN_COLOUR}" opacity="0.16"/>` +
    arrow +
    `<circle cx="30" cy="30" r="15" fill="${PIN_COLOUR}" stroke="#ffffff" stroke-width="3"/>` +
    `<text x="30" y="35" text-anchor="middle" font-family="Arial, sans-serif" ` +
    `font-size="13" font-weight="bold" fill="#ffffff">${initials}</text>` +
    `</svg>`;

  return {
    url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(60, 60),
    anchor: new google.maps.Point(30, 30),
  };
}

function calcBearing(from, to) {
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Two fixes 15 seconds apart are two points, and jumping between them looks
// like a glitch rather than a moving vehicle. Walking the marker across the
// gap is what makes the map read as live.
function glideTo(entry, to) {
  if (entry.frame) cancelAnimationFrame(entry.frame);

  const from = entry.pos || to;
  const start = performance.now();

  function step(now) {
    const t = Math.min((now - start) / MARKER_GLIDE_MS, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const at = {
      lat: from.lat + (to.lat - from.lat) * ease,
      lng: from.lng + (to.lng - from.lng) * ease,
    };
    entry.marker.setPosition(at);
    // Following a driver means staying with them the whole way across, not
    // catching up once they have stopped.
    if (selectedId === entry.id) map.panTo(at);
    if (t < 1) entry.frame = requestAnimationFrame(step);
    else entry.frame = null;
  }

  entry.frame = requestAnimationFrame(step);
}

function syncMarker(driver) {
  if (!map) return;

  const existing = markers.get(driver.id);

  // The map shows drivers who are sharing location, and nobody else. A driver
  // who has closed the app stops sending fixes, goes stale within the live
  // window and leaves the map — rather than lingering as a pin on a road they
  // have long since driven off, which is indistinguishable from a driver who
  // is genuinely parked there. Where they were last seen is not lost: it stays
  // on their row in the list beside the map.
  if (!driver.location || !driver.online) {
    if (existing) {
      if (existing.frame) cancelAnimationFrame(existing.frame);
      existing.marker.setMap(null);
      markers.delete(driver.id);
    }
    return;
  }

  const pos = {
    lat: Number(driver.location.latitude),
    lng: Number(driver.location.longitude),
  };
  if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;

  const initials = initialsFor(driver.full_name);

  if (!existing) {
    const marker = new google.maps.Marker({
      position: pos,
      map,
      title: driver.full_name || "Driver",
      icon: markerIcon(initials, null),
      zIndex: 10,
    });
    const entry = { id: driver.id, marker, pos, bearing: null, frame: null };
    // Clicking a pin selects the driver, the same as clicking their row —
    // whichever half of the page you are looking at works the same way.
    marker.addListener("click", () => selectDriver(driver.id));
    markers.set(driver.id, entry);
    return;
  }

  const moved =
    Math.abs(existing.pos.lat - pos.lat) > 1e-7 ||
    Math.abs(existing.pos.lng - pos.lng) > 1e-7;

  if (moved) {
    existing.bearing = calcBearing(existing.pos, pos);
    glideTo(existing, pos);
    existing.pos = pos;
  }

  existing.marker.setIcon(markerIcon(initials, existing.bearing));
  existing.marker.setTitle(driver.full_name || "Driver");
}

function syncMarkers() {
  const seen = new Set(drivers.map((driver) => driver.id));
  for (const [id, entry] of markers) {
    if (seen.has(id)) continue;
    if (entry.frame) cancelAnimationFrame(entry.frame);
    entry.marker.setMap(null);
    markers.delete(id);
  }
  drivers.forEach(syncMarker);
}

function fitAll() {
  if (!map) return;
  // Frames who is on the map, which is who is live — fitting to a position
  // last seen an hour ago would drag the view somewhere nothing is happening.
  const located = drivers.filter((driver) => driver.location && driver.online);
  if (!located.length) {
    map.setCenter(DEFAULT_CENTER);
    map.setZoom(12);
    return;
  }

  if (located.length === 1) {
    const only = located[0].location;
    map.setCenter({ lat: Number(only.latitude), lng: Number(only.longitude) });
    map.setZoom(15);
    return;
  }

  const bounds = new google.maps.LatLngBounds();
  located.forEach((driver) => {
    bounds.extend({
      lat: Number(driver.location.latitude),
      lng: Number(driver.location.longitude),
    });
  });
  map.fitBounds(bounds, 60);
}

/* ===========================
   Driver panel
=========================== */

// Clicking a driver locks the map onto them: it pans there now and keeps
// panning with every fix that arrives, until they are clicked again or
// "Show all" is pressed. Without this a dispatcher watching one delivery has
// to chase the pin by hand every fifteen seconds.
function selectDriver(id) {
  selectedId = selectedId === id ? null : id;
  renderList();

  if (selectedId == null) {
    fitAll();
    return;
  }

  const entry = markers.get(selectedId);
  if (entry) {
    map.panTo(entry.pos);
    if (map.getZoom() < 15) map.setZoom(15);
    return;
  }

  // No pin to follow. Worth saying which of the two reasons it is, because
  // "never shared a location" and "closed the app twenty minutes ago" call for
  // very different phone calls.
  const driver = drivers.find((candidate) => candidate.id === selectedId);
  showToast(
    driver && driver.location
      ? "That driver is not sharing location right now."
      : "That driver has not shared a location yet.",
    "info"
  );
}

// Rows are built as nodes with textContent rather than an HTML string: they
// carry driver names, customer names and order numbers straight from the
// database, none of which are safe to hand to the HTML parser.
function driverRow(driver) {
  const item = document.createElement("li");
  item.className = "driver-feed-item";
  if (driver.online) item.classList.add("is-online");
  if (driver.id === selectedId) item.classList.add("is-selected");
  if (!driver.location) item.classList.add("is-unlocated");

  const avatar = document.createElement("span");
  avatar.className = "feed-avatar";
  avatar.textContent = initialsFor(driver.full_name);

  const body = document.createElement("div");
  body.className = "feed-body";

  const nameRow = document.createElement("div");
  nameRow.className = "feed-name-row";

  const name = document.createElement("span");
  name.className = "feed-name";
  name.textContent = driver.full_name || `Driver #${driver.id}`;
  nameRow.appendChild(name);

  if (driver.online) {
    const dot = document.createElement("span");
    dot.className = "feed-live-dot";
    dot.setAttribute("aria-label", "Sharing location");
    nameRow.appendChild(dot);
  }

  // The delivery they are on now. The backend answers this from the orders
  // table rather than from the last GPS ping, so an order that has been
  // delivered or returned drops off this line instead of clinging to it.
  const detail = document.createElement("div");
  detail.className = "feed-detail";
  if (driver.order && driver.order.order_number) {
    const number = driver.order.order_number.startsWith("#")
      ? driver.order.order_number
      : `#${driver.order.order_number}`;
    detail.textContent = `${number} · ${statusLabel(driver.order.order_status)}`;
    // Where the order is going, kept off the visible line — the column is
    // narrow, and confusing it with where the driver is was the whole problem.
    detail.title = driver.order.city
      ? `${detail.textContent} · delivering to ${driver.order.city}`
      : detail.textContent;
  } else if (driver.active_orders > 0) {
    detail.textContent =
      driver.active_orders === 1
        ? "1 order assigned · not started"
        : `${driver.active_orders} orders assigned · not started`;
    detail.title = detail.textContent;
  } else {
    detail.textContent = "No active delivery";
    detail.title = detail.textContent;
  }

  // Where the driver is, not where they are heading. "In" is doing real work
  // here: this line sat next to the delivery city for a while, and a pin in
  // Ballouneh captioned "Tripoli" reads as a bug rather than as a destination.
  //
  // Once they stop sharing it becomes "Last seen in Ballouneh". They are off
  // the map by then, and this row is the only remaining record of where — so
  // it has to be clear it is history rather than a live position.
  const meta = document.createElement("div");
  meta.className = "feed-meta";
  const when = agoText(driver.location ? driver.location.age_seconds : null);
  const city = driver.location && driver.location.city;
  const where = city ? `${driver.online ? "In" : "Last seen in"} ${city} · ` : "";
  meta.textContent = `${where}${when}`;

  body.append(nameRow, detail, meta);

  const actions = document.createElement("div");
  actions.className = "feed-actions";

  // The row itself is the "follow this driver" control, so anything clickable
  // inside it has to stop the click before it reaches the row.
  function addAction(label, href, title, newTab) {
    const link = document.createElement("a");
    link.className = "feed-action";
    link.href = href;
    link.textContent = label;
    if (title) link.title = title;
    if (newTab) {
      link.target = "_blank";
      link.rel = "noopener";
    }
    link.addEventListener("click", (event) => event.stopPropagation());
    actions.appendChild(link);
  }

  if (driver.phone) addAction("Call", `tel:${driver.phone}`, driver.phone);

  // The customer's own view of this delivery — the quickest way to check what
  // the person waiting is being told before answering the phone to them.
  if (driver.order && driver.order.tracking_token) {
    addAction(
      "Track",
      `${API_ORIGIN}/track/track.html?token=${encodeURIComponent(driver.order.tracking_token)}`,
      "Open the customer's tracking page",
      true
    );
  }

  item.append(avatar, body, actions);
  item.addEventListener("click", () => selectDriver(driver.id));

  return item;
}

function renderList() {
  listEl.innerHTML = "";

  if (!drivers.length) {
    const empty = document.createElement("li");
    empty.className = "driver-feed-empty";
    empty.textContent = "No drivers yet. Add one on the Drivers page.";
    listEl.appendChild(empty);
    countEl.textContent = "No drivers";
    return;
  }

  drivers.forEach((driver) => listEl.appendChild(driverRow(driver)));

  const online = drivers.filter((driver) => driver.online).length;
  countEl.textContent =
    online === 0
      ? `No drivers sharing location · ${drivers.length} total`
      : `${online} of ${drivers.length} drivers live`;
}

function stampUpdated() {
  updatedEl.textContent = `Updated ${new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

/* ===========================
   Data
=========================== */

let liveWindowSeconds = 120;

async function loadDrivers() {
  try {
    const data = await getDriverLocations();
    drivers = Array.isArray(data.drivers) ? data.drivers : [];
    if (data.live_window_seconds) liveWindowSeconds = data.live_window_seconds;

    renderList();
    syncMarkers();
    stampUpdated();
  } catch (error) {
    // A 401 has already redirected to login by this point; anything else is
    // worth saying once rather than leaving the panel silently frozen.
    if (error && error.message !== "Session expired") {
      console.error("Failed to load driver locations:", error);
      showToast("Could not refresh driver locations.", "error");
    }
  }
}

// A fix arrived for a driver the page has never heard of — newly hired, or
// newly assigned — so the fleet list needs rereading. Debounced because a
// batch of drivers coming on shift together would otherwise fire a burst.
function scheduleRefetch() {
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    loadDrivers();
  }, 1500);
}

/* ===========================
   Live socket
=========================== */

function connectSocket() {
  const token = localStorage.getItem("adminToken");
  if (!token || typeof io === "undefined") return;

  const socket = io(API_ORIGIN, {
    query: { dispatch: token },
    transports: ["websocket", "polling"],
  });

  socket.on("driver_location", (ping) => {
    const driver = drivers.find((candidate) => candidate.id === ping.driver_id);
    if (!driver) {
      scheduleRefetch();
      return;
    }

    driver.location = {
      latitude: ping.latitude,
      longitude: ping.longitude,
      updated_at: ping.updated_at,
      // The town name is not carried on the ping — it costs a geocode, which
      // belongs on the poll. Keeping the last known one avoids the caption
      // blinking out between polls while the driver is plainly still there.
      city: driver.location ? driver.location.city : null,
      age_seconds: 0,
    };
    driver.online = true;

    // Which delivery the driver is on is the poll's answer, never the ping's:
    // the ping only knows which order it was filed against, which is exactly
    // the stale reading this line used to copy onto the row. What it is good
    // for is noticing they have moved onto a different order than the one the
    // panel is showing — that means the panel is out of date, so refetch.
    if (ping.order && (!driver.order || driver.order.id !== ping.order.id)) {
      scheduleRefetch();
    }

    syncMarker(driver);
    renderList();
    stampUpdated();
  });

  socket.on("driver_status", (event) => {
    const driver = drivers.find((candidate) => candidate.id === event.driver_id);
    if (!driver || !event.order) return;

    // Relabel the delivery on the row straight away when it is the one that
    // changed, so the dispatcher sees it land rather than waiting for a poll.
    if (driver.order && driver.order.id === event.order.id) {
      driver.order.order_status = event.order.order_status;
      renderList();
    }

    // Then confirm with the server. A status change can move an order out of
    // the driver's hands entirely — delivered, returned — and what should
    // replace it on the row (their next order, or nothing) is not something
    // this event can say.
    scheduleRefetch();
  });
}

/* ===========================
   Ageing between fetches
=========================== */

// Nothing arriving is itself information. Without this the panel would keep
// saying "Live now" about a driver whose phone died two minutes ago, until the
// next successful poll happened to notice.
function ageLocations() {
  let changed = false;

  drivers.forEach((driver) => {
    if (!driver.location || driver.location.age_seconds == null) return;
    driver.location.age_seconds += 1;
    const stillOnline = driver.location.age_seconds <= liveWindowSeconds;
    if (stillOnline !== driver.online) {
      driver.online = stillOnline;
      syncMarker(driver);
      changed = true;
    }
  });

  // Redrawing the whole list every second would fight with clicking it, so it
  // is only rebuilt when a driver actually crossed the line into stale.
  if (changed) renderList();
}

/* ===========================
   Google Maps
=========================== */

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    zoom: 12,
    center: DEFAULT_CENTER,
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: "greedy",
    // The same stripped-back styling as the customer's map: shops, bus stops
    // and road shields are noise when what you are reading is where six pins
    // are relative to each other.
    styles: [
      { featureType: "poi", stylers: [{ visibility: "off" }] },
      { featureType: "transit", stylers: [{ visibility: "off" }] },
      { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    ],
  });

  syncMarkers();
  if (!hasFitOnce && drivers.length) {
    fitAll();
    hasFitOnce = true;
  }
}

// A blocked or throttled request to Google can hang rather than fail — no
// onerror ever arrives, and the page would sit on an empty grey rectangle with
// nothing to say for itself. The deadline is what turns that into a message.
const MAPS_LOAD_TIMEOUT_MS = 10_000;

function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("Google Maps did not load in time")),
      MAPS_LOAD_TIMEOUT_MS
    );

    window.__initDispatchMap = () => {
      clearTimeout(deadline);
      resolve();
    };

    const script = document.createElement("script");
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${MAPS_BROWSER_KEY}` +
      `&callback=__initDispatchMap`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      clearTimeout(deadline);
      reject(new Error("Google Maps failed to load"));
    };
    document.head.appendChild(script);
  });
}

/* ===========================
   Bootstrap
=========================== */

fitAllBtn.addEventListener("click", () => {
  selectedId = null;
  renderList();
  fitAll();
});

// A tab left open on a wall screen should not keep polling all night, and a
// tab brought back to the front should not show a stale map for 20 seconds.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  } else if (!pollTimer) {
    loadDrivers();
    pollTimer = setInterval(loadDrivers, POLL_MS);
  }
});

(async () => {
  // The list first: it is useful on its own, and it means a slow map script
  // does not hold up the answer to "who is out right now".
  await loadDrivers();
  connectSocket();

  pollTimer = setInterval(loadDrivers, POLL_MS);
  setInterval(ageLocations, 1000);

  try {
    await loadGoogleMaps();
    initMap();
  } catch (error) {
    console.error(error);
    fallbackEl.hidden = false;
  }
})();
