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
// Every driver who has ever filed a position gets a pin, and the pin says
// which kind of position it is. Green and moving means the fixes are still
// arriving. Grey and dashed means this is where they were last seen — the app
// was closed, the phone died, or they drove into a valley — and the row beside
// it says how long ago. That is a great deal more useful than an empty map:
// "he was in Jounieh twenty minutes ago" is where you start looking.
//
// Each pin is labelled with what the driver is carrying. A driver can be on
// several deliveries at once — one trip out of the shop with four bags in it —
// so the panel lists every open order they hold, marks the ones actually on
// the road, and gives each its own link to the customer's tracking page.

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

// A pin in the shape of the answer: who it is, which way they are heading, and
// whether this is where they are or only where they were.
//
// The two states have to be told apart at a glance and without reading, since
// a dispatcher scanning the map for the nearest free driver must not mistake a
// half-hour-old position for a live one. Green with a solid halo is live.
// Grey with a dashed ring is a last known position, and it loses the heading
// arrow with it — the direction someone was travelling in twenty minutes ago
// is not information, it is decoration.
const LIVE_COLOUR = "#16a34a";
const STALE_COLOUR = "#9ca3af";

function markerIcon(initials, bearing, online) {
  const colour = online ? LIVE_COLOUR : STALE_COLOUR;

  // The arrow only means something when we know where they were going, which
  // takes two fixes; until then the pin is just the disc.
  const arrow =
    !online || bearing == null
      ? ""
      : `<g transform="rotate(${bearing.toFixed(0)} 30 30)">
           <path d="M30 3 L36 14 L24 14 Z" fill="${colour}"/>
         </g>`;

  const halo = online
    ? `<circle cx="30" cy="30" r="27" fill="${colour}" opacity="0.16"/>`
    : `<circle cx="30" cy="30" r="24" fill="none" stroke="${colour}" ` +
      `stroke-width="2" stroke-dasharray="5 4" opacity="0.85"/>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">` +
    halo +
    arrow +
    `<circle cx="30" cy="30" r="15" fill="${colour}" stroke="#ffffff" stroke-width="3"` +
    (online ? "" : ` opacity="0.9"`) +
    `/>` +
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

// The label a pin carries when hovered or read by a screen reader: the driver,
// then what they are doing, so the map answers on its own without the panel.
function markerTitle(driver) {
  const name = driver.full_name || "Driver";
  const carrying = (driver.orders || [])
    .map((order) => `${orderNumberText(order)} · ${statusLabel(order.order_status)}`)
    .join(", ");
  const where = driver.location && driver.location.city
    ? `${driver.online ? "in" : "last seen in"} ${driver.location.city}`
    : null;

  return [name, where, carrying || "no active delivery"].filter(Boolean).join(" — ");
}

function syncMarker(driver) {
  if (!map) return;

  const existing = markers.get(driver.id);

  // Only a driver we have never had a position for has no pin at all. Once one
  // has arrived it stays on the map: while the fixes keep coming it is where
  // the driver is, and when they stop it turns grey and becomes where the
  // driver was last seen. The row beside the map says how long ago that was,
  // so the two readings cannot be confused — and a dispatcher looking for a
  // driver who has gone quiet is given the one thing that actually helps,
  // which is the last place anyone saw them.
  if (!driver.location) {
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
      title: markerTitle(driver),
      icon: markerIcon(initials, null, driver.online),
      // Live pins sit above last-seen ones, so a driver who is out there now is
      // never hidden behind the ghost of one who went home.
      zIndex: driver.online ? 10 : 5,
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

  existing.marker.setIcon(markerIcon(initials, existing.bearing, driver.online));
  existing.marker.setZIndex(driver.online ? 10 : 5);
  existing.marker.setTitle(markerTitle(driver));
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
  // Frames every pin on the map, last-seen ones included: "show all" that left
  // a driver off the screen would be answering a different question from the
  // one the button asks.
  const located = drivers.filter((driver) => driver.location);
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

  // No pin at all, which now means only one thing: this driver has never
  // shared a position. A driver who has gone quiet still has a last-seen pin
  // to fly to, and the click above lands on it.
  showToast("That driver has not shared a location yet.", "info");
}

// Order numbers are stored with and without the leading hash depending on how
// the order reached us, and "#2706" is how everyone refers to them.
function orderNumberText(order) {
  const number = String(order.order_number || "").trim();
  if (!number) return `Order ${order.id}`;
  return number.startsWith("#") ? number : `#${number}`;
}

// One delivery on the driver's row: which order, from which shop, how far
// along, and a way straight to what the customer waiting for it can see.
//
// Whether it is under way is the distinction that matters most here, and it is
// the one the panel used to lose. A driver holding four orders has tapped
// "Start Delivery" on some of them and not on others; the started ones are the
// deliveries in progress and are marked live, the rest are still in the box.
function orderLine(order) {
  const line = document.createElement("div");
  line.className = "feed-order";
  if (order.started) line.classList.add("is-started");

  const main = document.createElement("div");
  main.className = "feed-order-main";

  const text = document.createElement("span");
  text.className = "feed-order-text";
  text.textContent = `${orderNumberText(order)} · ${statusLabel(order.order_status)}`;

  // Where the order is going, kept off the visible line — the column is
  // narrow, and confusing it with where the driver is was the whole problem.
  text.title = order.city
    ? `${text.textContent} · delivering to ${order.city}`
    : text.textContent;

  main.appendChild(text);

  // The customer's own view of this delivery — the quickest way to check what
  // the person waiting is being told before answering the phone to them. One
  // per order, because with four in hand a single button cannot say which
  // delivery it would open.
  if (order.tracking_token) {
    const track = document.createElement("a");
    track.className = "feed-order-track";
    track.href = `${API_ORIGIN}/track/track.html?token=${encodeURIComponent(order.tracking_token)}`;
    track.textContent = "Track";
    track.title = `Open the customer's tracking page for ${orderNumberText(order)}`;
    track.target = "_blank";
    track.rel = "noopener";
    // The row itself is the "follow this driver" control, so anything
    // clickable inside it has to stop the click before it reaches the row.
    track.addEventListener("click", (event) => event.stopPropagation());
    main.appendChild(track);
  }

  line.appendChild(main);

  // Which shop the bag came from. A driver runs for several, and an order
  // number on its own does not say which counter it was picked up at.
  //
  // On its own line rather than tacked onto the one above: a number, a status
  // and a shop name do not fit across a column this narrow, and the half that
  // got cut off was always the shop.
  if (order.store_name) {
    const store = document.createElement("div");
    store.className = "feed-order-store";
    store.textContent = order.store_name;
    store.title = order.store_name;
    line.appendChild(store);
  }

  return line;
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

  // Everything they are carrying, one line each. The backend answers this from
  // the orders table rather than from the last GPS ping, so an order that has
  // been delivered or returned drops off instead of clinging on.
  const orders = Array.isArray(driver.orders) ? driver.orders : [];

  const detail = document.createElement("div");
  detail.className = "feed-orders";

  if (!orders.length) {
    const none = document.createElement("div");
    none.className = "feed-detail";
    none.textContent = "No active delivery";
    detail.appendChild(none);
  } else {
    orders.forEach((order) => detail.appendChild(orderLine(order)));
  }

  // Which town the driver is in, directly under the orders they are carrying:
  // the two questions a dispatcher asks together are "what has he got" and
  // "where has he got to". "In" is doing real work here — this line sits
  // against the delivery city, and a driver in Ballouneh captioned "Tripoli"
  // reads as a bug rather than as a destination.
  //
  // Once they stop sharing it becomes "Last seen in Ballouneh · 20 min ago",
  // which is exactly what the grey pin on the map is saying. The town comes
  // from the server, which asks Google and falls back to the nearest town in
  // its own table, so this line survives a missing key or a bad minute.
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

    // What the driver is carrying is the poll's answer, never the ping's: the
    // ping only knows which order it was filed against, which is exactly the
    // stale reading this used to copy onto the row. What it is good for is the
    // one fact it cannot be wrong about — that this order is being pinged, so
    // that delivery is under way — and for noticing an order the panel has
    // never heard of, which means the panel is out of date.
    if (ping.order) {
      const carried = (driver.orders || []).find(
        (order) => order.id === ping.order.id
      );
      if (!carried) scheduleRefetch();
      else if (!carried.started) carried.started = true;
    }

    syncMarker(driver);
    renderList();
    stampUpdated();
  });

  socket.on("driver_status", (event) => {
    const driver = drivers.find((candidate) => candidate.id === event.driver_id);
    if (!driver || !event.order) return;

    // Relabel the delivery on the row straight away, so the dispatcher sees
    // the change land rather than waiting for a poll.
    const carried = (driver.orders || []).find(
      (order) => order.id === event.order.id
    );
    if (carried) {
      carried.order_status = event.order.order_status;
      renderList();
      syncMarker(driver);
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
      // No fixes arriving means no delivery is streaming either, whatever the
      // last poll said. The orders stay on the row — they are still in the
      // driver's hands — but none of them is under way as far as we can tell.
      if (!stillOnline) {
        (driver.orders || []).forEach((order) => {
          order.started = false;
        });
      }
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
