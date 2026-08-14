// The Performance page: what each driver did in a period, and what to hand
// them when the money is counted at the end of it.
//
// The page is deliberately built around one moment — the dispatcher standing
// with a driver and a pile of cash. Everything else (delivery counts, returns,
// averages) is context for the two numbers that settle that moment: what the
// driver collected, and what the store owes them at the flat fee per delivery.
// Those two produce the third, which is the only one anybody acts on: how much
// cash actually comes back across the table.
//
// No arithmetic happens here that the backend has not already done. The cards
// display figures; they do not compute them. That is what keeps this page,
// the CSV it exports and the driver's own app from ever showing three
// different answers for the same day's pay.

import { getDriverPerformance, getDriverPerformanceOrders } from "./api.js";
import { showToast } from "./ui.js";

const cardsEl = document.querySelector("#driverCards");
const periodSummaryEl = document.querySelector("#periodSummary");
const fromInput = document.querySelector("#fromDate");
const toInput = document.querySelector("#toDate");
const showAllEl = document.querySelector("#showAllDrivers");

const totals = {
  deliveries: document.querySelector("#totalDeliveries"),
  deliveriesNote: document.querySelector("#deliveriesNote"),
  cash: document.querySelector("#totalCash"),
  cashNote: document.querySelector("#cashNote"),
  pay: document.querySelector("#totalPay"),
  payNote: document.querySelector("#payNote"),
  net: document.querySelector("#totalNet"),
  netTitle: document.querySelector("#netTitle"),
  netCard: document.querySelector("#netCard"),
  out: document.querySelector("#totalOut"),
  outNote: document.querySelector("#outNote"),
};

// The report currently on screen. Held so the CSV export writes exactly what
// the dispatcher is looking at rather than re-fetching and risking a different
// answer mid-count.
let report = null;

// Set when the page was opened from a driver's row on the Drivers tab
// (performance.html?driver=13). The whole page then answers for that one
// driver — cards, totals and export alike — because someone who arrived by
// clicking a name is settling up with that person, not reading the store's
// day. Null means the normal all-drivers view.
const focusDriverId = readFocusDriverId();

function readFocusDriverId() {
  const raw = new URLSearchParams(window.location.search).get("driver");
  const id = Number(raw);
  return raw && Number.isInteger(id) && id > 0 ? id : null;
}

// The driver the page is focused on, once a report has been loaded. Null in
// the all-drivers view, and also when the id in the URL matches nobody — a
// deleted driver, or a hand-edited link.
function focusedDriver() {
  if (!report || focusDriverId === null) return null;
  return report.drivers.find((driver) => driver.id === focusDriverId) || null;
}

// Which driver cards have their order list open, by driver id. Kept across
// reloads so changing the date range does not collapse everything.
//
// A card opened from the Drivers tab starts expanded: clicking "Check
// Performance" on someone's row is a request to see their work, and the
// orders are the work.
const expanded = new Set();
if (focusDriverId !== null) expanded.add(focusDriverId);

/* ===========================
   FORMATTING
=========================== */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Always two decimals: this is money about to be counted out in notes, and
// "$137" next to "$137.50" invites the wrong pile.
function money(value) {
  const amount = Number(value) || 0;
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function minutesLabel(minutes) {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// The backend sends "YYYY-MM-DD HH:MM" already in the store's timezone, so the
// only job left is to drop the date when it adds nothing.
function clockLabel(stamp) {
  if (!stamp) return "—";
  const [date, time] = stamp.split(" ");
  return report && report.from === report.to && date === report.from ? time : stamp;
}

/* ===========================
   DATE RANGE
=========================== */

// Calendar dates are treated as plain strings and shifted through UTC, never
// through the local calendar: adding a day to a date must not depend on which
// side of a daylight-saving change the browser happens to be on.
function shiftDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

// Today where the store is. The report's timezone is the authority — a
// dispatcher working from another country still settles the store's day.
function storeToday() {
  const timeZone = report ? report.timezone : undefined;
  try {
    // en-CA renders as YYYY-MM-DD, the shape the API expects.
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    // An unknown timezone from the server should degrade to the browser's
    // calendar rather than blanking the page.
    return new Intl.DateTimeFormat("en-CA").format(new Date());
  }
}

// Monday-first, matching the driver app's own week so a driver comparing their
// screen with the dispatcher's sees the same window.
function weekStart(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  return shiftDays(isoDate, -weekday);
}

function presetRange(preset) {
  const today = storeToday();

  if (preset === "yesterday") {
    const day = shiftDays(today, -1);
    return { from: day, to: day };
  }
  if (preset === "week") return { from: weekStart(today), to: today };
  if (preset === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: today, to: today };
}

// Names the window in the words the dispatcher would use, so the header says
// what is being counted without them re-reading the two date fields.
function describeRange(from, to) {
  const today = storeToday();
  if (from === to) {
    if (from === today) return "Today";
    if (from === shiftDays(today, -1)) return "Yesterday";
    return from;
  }
  return `${from} → ${to}`;
}

function markActivePreset() {
  if (!report) return;
  document.querySelectorAll(".period-btn").forEach((button) => {
    const range = presetRange(button.dataset.preset);
    const isActive = range.from === report.from && range.to === report.to;
    button.classList.toggle("period-btn-active", isActive);
  });
}

/* ===========================
   RENDERING
=========================== */

// The figures the header cards show. In the all-drivers view that is the
// store roll-up the backend sent; focused on one driver it is that driver's
// own row, reshaped rather than recalculated — every field here already came
// back computed, so the header cannot drift from the card beneath it.
function activeTotals() {
  const driver = focusedDriver();
  if (!driver) return report.totals;

  return {
    drivers_worked: driver.delivered > 0 || driver.returned > 0 ? 1 : 0,
    delivered: driver.delivered,
    prepaid_deliveries: driver.prepaid_deliveries,
    returned: driver.returned,
    cash_collected: driver.cash_collected,
    prepaid_value: driver.prepaid_value,
    returned_value: driver.returned_value,
    orders_out: driver.orders_out,
    cash_out: driver.cash_out,
    pay_owed: driver.pay_owed,
    cash_to_hand_in: driver.cash_to_hand_in,
  };
}

function renderTotals() {
  const t = activeTotals();
  const fee = report.fee_per_delivery;

  totals.deliveries.textContent = t.delivered;
  // "1 driver worked" is a useless thing to tell someone who is looking at one
  // driver on purpose, so the focused view spends the line on the returns
  // instead.
  const worked = `${t.drivers_worked} driver${t.drivers_worked === 1 ? "" : "s"} worked`;
  const returns = `${t.returned} returned`;
  totals.deliveriesNote.textContent = focusedDriver()
    ? t.returned
      ? returns
      : "Completed deliveries"
    : worked + (t.returned ? ` · ${returns}` : "");

  totals.cash.textContent = money(t.cash_collected);
  // Prepaid orders are called out rather than hidden: the driver delivered
  // them and is paid for them, but brought back no cash, which is exactly the
  // gap someone counting the bag is about to notice.
  totals.cashNote.textContent = t.prepaid_deliveries
    ? `${t.prepaid_deliveries} prepaid delivery${t.prepaid_deliveries === 1 ? "" : "s"} brought no cash (${money(t.prepaid_value)})`
    : "Collected at the door";

  totals.pay.textContent = money(t.pay_owed);
  totals.payNote.textContent = `${t.delivered} × ${money(fee)} per delivery`;

  // On a day where the fees outran the cash — an all-prepaid run — the till
  // loses money rather than keeping it, and the card has to say so instead of
  // reporting a negative amount kept.
  const payingOut = t.cash_to_hand_in < 0;
  totals.netTitle.textContent = payingOut ? "Cash you pay out" : "Cash you keep";
  totals.net.textContent = money(Math.abs(t.cash_to_hand_in));
  totals.netCard.classList.toggle("stat-card-owed", payingOut);

  totals.out.textContent = t.orders_out;
  totals.outNote.textContent = t.orders_out
    ? `${money(t.cash_out)} not collected yet`
    : "Nothing outstanding";

  const driver = focusedDriver();
  periodSummaryEl.textContent =
    (driver ? `${driver.full_name} · ` : "") +
    `${describeRange(report.from, report.to)} — ${report.from} to ${report.to} ` +
    `(${report.timezone})`;
}

/* ===========================
   MONEY TO COLLECT
=========================== */

// The whole roster on one line each, under the one figure the day ends on.
//
// The cards below this are for settling with one driver at a time; this table
// is for the dispatcher who wants the store's whole position at a glance —
// every driver, every column that feeds the money, and the total to take from
// them at the bottom. Nothing here is recomputed: the rows are the same
// per-driver figures the cards show, and the total row is the backend's own
// roll-up rather than a sum of what happens to be on screen.
const collection = {
  section: document.querySelector("#collectionSection"),
  total: document.querySelector("#collectTotal"),
  note: document.querySelector("#collectNote"),
  payOutBlock: document.querySelector("#payOutBlock"),
  payOut: document.querySelector("#payOutTotal"),
  payOutNote: document.querySelector("#payOutNote"),
  table: document.querySelector("#totalsTable"),
  notes: document.querySelector("#collectionNotes"),
};

const COLLECTION_COLUMNS = [
  "Driver",
  "Delivered",
  "Returned",
  "Prepaid",
  "Avg to deliver",
  "Cash collected",
  "Prepaid value",
  "Returned value",
  "Driver's pay",
  "To collect",
  "Still out",
  "Cash still out",
];

function renderCollection() {
  // Focused on one driver: their own card already is the settlement, and a
  // one-row "all drivers" table above it would only invite double-counting.
  if (focusDriverId !== null) {
    collection.section.hidden = true;
    return;
  }
  collection.section.hidden = false;

  const t = report.totals;

  collection.total.textContent = money(t.to_collect);
  collection.note.textContent = t.drivers_owing
    ? `From ${t.drivers_owing} driver${t.drivers_owing === 1 ? "" : "s"} · ` +
      `${money(t.cash_collected)} collected − ${money(t.pay_owed)} pay`
    : "Nothing to collect for this period";

  // The store paying a driver out is the exception, so the block only appears
  // when it applies rather than sitting at zero next to the number that matters.
  collection.payOutBlock.hidden = t.to_pay_out <= 0;
  collection.payOut.textContent = money(t.to_pay_out);
  collection.payOutNote.textContent =
    `${t.drivers_to_pay} driver${t.drivers_to_pay === 1 ? "" : "s"} earned more in fees ` +
    `than they collected`;

  // Same roster rule as the cards: quiet drivers are hidden unless asked for,
  // but anyone still holding the store's cash is shown however quiet the period.
  const visible = showAllEl.checked
    ? report.drivers
    : report.drivers.filter(
        (d) => d.delivered > 0 || d.returned > 0 || d.orders_out > 0
      );

  const head = COLLECTION_COLUMNS.map((label) => `<th>${label}</th>`).join("");

  const rows = visible
    .map((d) => {
      const owed = d.cash_to_hand_in < 0;
      return `
        <tr>
          <td class="totals-driver">
            ${escapeHtml(d.full_name)}
            ${d.phone ? `<span class="muted-inline">${escapeHtml(d.phone)}</span>` : ""}
          </td>
          <td>${d.delivered}</td>
          <td>${d.returned}</td>
          <td>${d.prepaid_deliveries}</td>
          <td>${escapeHtml(minutesLabel(d.avg_minutes_to_deliver))}</td>
          <td>${money(d.cash_collected)}</td>
          <td>${money(d.prepaid_value)}</td>
          <td>${money(d.returned_value)}</td>
          <td class="totals-pay">${money(-d.pay_owed)}</td>
          <td class="totals-collect${owed ? " totals-collect-owed" : ""}">
            ${money(Math.abs(d.cash_to_hand_in))}${owed ? " <span class=\"muted-inline\">to pay</span>" : ""}
          </td>
          <td>${d.orders_out || "—"}</td>
          <td>${d.orders_out ? money(d.cash_out) : "—"}</td>
        </tr>`;
    })
    .join("");

  const body = rows
    ? rows
    : `<tr><td class="empty-cell" colspan="${COLLECTION_COLUMNS.length}">
         No driver activity in this period.
       </td></tr>`;

  collection.table.innerHTML = `
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot>
      <tr>
        <td class="totals-driver">All drivers</td>
        <td>${t.delivered}</td>
        <td>${t.returned}</td>
        <td>${t.prepaid_deliveries}</td>
        <td>—</td>
        <td>${money(t.cash_collected)}</td>
        <td>${money(t.prepaid_value)}</td>
        <td>${money(t.returned_value)}</td>
        <td class="totals-pay">${money(-t.pay_owed)}</td>
        <td class="totals-collect">${money(t.to_collect)}</td>
        <td>${t.orders_out || "—"}</td>
        <td>${t.orders_out ? money(t.cash_out) : "—"}</td>
      </tr>
    </tfoot>
  `;

  // The caveats that change what the total means, and only those. Each one is
  // money that is real but not in the figure above.
  collection.notes.innerHTML = "";
  if (t.orders_out) {
    collection.notes.appendChild(
      note(
        `${money(t.cash_out)} is still on the road on ${t.orders_out} undelivered ` +
          `order${t.orders_out === 1 ? "" : "s"} — not part of the total to collect until they are delivered.`
      )
    );
  }
  if (t.prepaid_deliveries) {
    collection.notes.appendChild(
      note(
        `${t.prepaid_deliveries} prepaid ${t.prepaid_deliveries === 1 ? "delivery" : "deliveries"} ` +
          `(${money(t.prepaid_value)}) were paid online, so they brought back no cash but still earn the fee.`
      )
    );
  }
  if (t.returned) {
    collection.notes.appendChild(
      note(
        `${t.returned} order${t.returned === 1 ? "" : "s"} came back (${money(t.returned_value)}) — ` +
          `no cash and no fee, so they change nothing above.`
      )
    );
  }
  if (t.to_pay_out > 0) {
    collection.notes.appendChild(
      note(
        `Collecting ${money(t.to_collect)} and paying out ${money(t.to_pay_out)} leaves ` +
          `${money(t.cash_to_hand_in)} in the till for this period.`
      )
    );
  }
}

// One driver, one card. The settlement block is the point of the card, so it
// gets the room and the weight; the counts above it are the evidence for it.
function driverCard(driver) {
  const fee = report.fee_per_delivery;
  const card = document.createElement("article");
  card.className = "driver-perf-card";
  if (driver.delivered === 0 && driver.returned === 0) {
    card.classList.add("driver-perf-card-idle");
  }

  const outBadge = driver.orders_out
    ? `<span class="badge badge-out">${driver.orders_out} on the road</span>`
    : "";

  // A day of nothing but prepaid orders earns fees without bringing in any
  // cash, so the settlement runs the other way: the driver hands over nothing
  // and the store pays them out of the till. Showing that as a negative amount
  // under "Hands you" would read as money coming in.
  const owed = driver.cash_to_hand_in < 0;

  card.innerHTML = `
    <header class="driver-perf-head">
      <div>
        <h3>${escapeHtml(driver.full_name)}</h3>
        <p class="driver-perf-phone">${escapeHtml(driver.phone ?? "")}</p>
      </div>
      ${outBadge}
    </header>

    <div class="driver-perf-stats">
      <div><span class="perf-label">Delivered</span><strong>${driver.delivered}</strong></div>
      <div><span class="perf-label">Returned</span><strong>${driver.returned}</strong></div>
      <div><span class="perf-label">Prepaid</span><strong>${driver.prepaid_deliveries}</strong></div>
      <div title="Average time on the road: from the driver tapping Start Delivery to marking the order delivered. Returns are not counted."><span class="perf-label">Avg to deliver</span><strong>${minutesLabel(driver.avg_minutes_to_deliver)}</strong></div>
      <div><span class="perf-label">First</span><strong>${escapeHtml(clockLabel(driver.first_delivery_at))}</strong></div>
      <div><span class="perf-label">Last</span><strong>${escapeHtml(clockLabel(driver.last_delivery_at))}</strong></div>
    </div>

    <div class="settlement">
      <div class="settlement-row">
        <span>Cash collected</span>
        <span>${money(driver.cash_collected)}</span>
      </div>
      <div class="settlement-row settlement-pay">
        <span>Driver's pay — ${driver.delivered} × ${money(fee)}</span>
        <span>${money(-driver.pay_owed)}</span>
      </div>
      <div class="settlement-row settlement-total${owed ? " settlement-total-owed" : ""}">
        <span>${owed ? "You pay out" : "Hands you"}</span>
        <span>${money(Math.abs(driver.cash_to_hand_in))}</span>
      </div>
    </div>

    <ul class="driver-perf-notes"></ul>

    <button class="link-btn" type="button" data-toggle="${driver.id}">
      ${expanded.has(driver.id) ? "Hide orders" : "View orders"}
    </button>
    <div class="driver-orders" data-orders="${driver.id}"></div>
  `;

  // The footnotes only appear when they have something to say — a card that
  // repeats "no returns, nothing outstanding" for every driver trains the eye
  // to skip the line that one day matters.
  const notes = card.querySelector(".driver-perf-notes");
  if (driver.orders_out) {
    notes.appendChild(
      note(
        `Still carrying ${money(driver.cash_out)} on ${driver.orders_out} undelivered ` +
          `order${driver.orders_out === 1 ? "" : "s"} — not counted above.`
      )
    );
  }
  if (driver.prepaid_deliveries) {
    notes.appendChild(
      note(
        `${driver.prepaid_deliveries} prepaid ${driver.prepaid_deliveries === 1 ? "delivery" : "deliveries"} ` +
          `(${money(driver.prepaid_value)}) — paid online, so no cash, but still earns the fee.`
      )
    );
  }
  if (driver.returned) {
    notes.appendChild(
      note(
        `${driver.returned} order${driver.returned === 1 ? "" : "s"} came back ` +
          `(${money(driver.returned_value)}) — no fee, no cash.`
      )
    );
  }

  const toggle = card.querySelector("[data-toggle]");
  toggle.addEventListener("click", () => toggleOrders(driver, card, toggle));

  if (expanded.has(driver.id)) loadOrders(driver, card);

  return card;
}

function note(text) {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

function toggleOrders(driver, card, toggle) {
  if (expanded.has(driver.id)) {
    expanded.delete(driver.id);
    card.querySelector("[data-orders]").innerHTML = "";
    toggle.textContent = "View orders";
    return;
  }

  expanded.add(driver.id);
  toggle.textContent = "Hide orders";
  loadOrders(driver, card);
}

// The receipt behind the card: every order that fed a number above it, so a
// figure that looks wrong can be traced to the delivery that caused it.
async function loadOrders(driver, card) {
  const host = card.querySelector("[data-orders]");
  host.innerHTML = `<p class="empty-note">Loading orders…</p>`;

  try {
    const detail = await getDriverPerformanceOrders(driver.id, {
      from: report.from,
      to: report.to,
    });

    if (!detail.orders.length) {
      host.innerHTML = `<p class="empty-note">No deliveries or returns in this period.</p>`;
      return;
    }

    const rows = detail.orders
      .map(
        (order) => `
        <tr>
          <td>${escapeHtml(order.order_number ?? order.id)}</td>
          <td>${escapeHtml(
            [order.customer_first_name, order.customer_last_name].filter(Boolean).join(" ")
          )}</td>
          <td>${escapeHtml(order.city ?? "")}</td>
          <td>${escapeHtml(
            clockLabel(order.delivered_local || order.returned_local || order.created_local)
          )}${
            order.minutes_to_deliver === null || order.minutes_to_deliver === undefined
              ? ""
              : ` <span class="muted-inline">(${escapeHtml(
                  minutesLabel(order.minutes_to_deliver)
                )})</span>`
          }</td>
          <td>${money(order.total_price)}</td>
          <td>${
            order.kind === "RETURNED"
              ? `<span class="status-badge status-returned">Returned</span>`
              : order.prepaid
              ? `<span class="status-badge status-prepaid">Prepaid</span>`
              : `<span class="status-badge status-delivered">Cash</span>`
          }</td>
          <td class="cash-cell">${money(order.cash)}</td>
        </tr>`
      )
      .join("");

    host.innerHTML = `
      <table class="orders-mini">
        <thead>
          <tr>
            <th>Order</th><th>Customer</th><th>City</th><th>Time</th>
            <th>Total</th><th>Payment</th><th>Cash in hand</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (error) {
    console.error("Failed to load driver orders:", error);
    host.innerHTML = `<p class="empty-note">Could not load this driver's orders.</p>`;
  }
}

function renderDrivers() {
  cardsEl.innerHTML = "";

  // Opened from a driver's row: show that driver and nothing else, including
  // on a day they did not work — an empty settlement is the answer to "what
  // does this person owe me", not a reason to show the whole roster instead.
  if (focusDriverId !== null) {
    const driver = focusedDriver();
    if (!driver) {
      cardsEl.innerHTML = `<p class="empty-note">That driver no longer exists.</p>`;
      return;
    }
    cardsEl.appendChild(driverCard(driver));
    return;
  }

  // Drivers are shared across stores, so a store's list can include people who
  // have never worked for it. Those are hidden unless asked for — but a driver
  // who is out on a delivery right now always shows, however quiet the period,
  // because they are holding the store's cash.
  const visible = showAllEl.checked
    ? report.drivers
    : report.drivers.filter(
        (d) => d.delivered > 0 || d.returned > 0 || d.orders_out > 0
      );

  if (!visible.length) {
    cardsEl.innerHTML = `<p class="empty-note">No driver activity in this period.</p>`;
    return;
  }

  visible.forEach((driver) => cardsEl.appendChild(driverCard(driver)));
}

/* ===========================
   LOADING
=========================== */

async function load(range) {
  cardsEl.innerHTML = `<p class="empty-note">Loading…</p>`;

  try {
    report = await getDriverPerformance(range);
  } catch (error) {
    console.error("Failed to load performance report:", error);
    cardsEl.innerHTML = `<p class="empty-note">Failed to load the report. Try again.</p>`;
    showToast("Could not load driver performance.", "error");
    return;
  }

  // The response is the authority on the period, not the inputs: an omitted
  // range comes back resolved to the store's today, and the fields have to
  // follow so the next Apply starts from what is on screen.
  fromInput.value = report.from;
  toInput.value = report.to;

  renderFocusChrome();
  renderTotals();
  markActivePreset();
  renderCollection();
  renderDrivers();
}

// Dresses the section header for whichever view is showing. Done after the
// report lands because the driver's name is only known then.
function renderFocusChrome() {
  const driver = focusedDriver();
  const focusing = focusDriverId !== null;

  document.querySelector("#backToDrivers").hidden = !focusing;
  document.querySelector("#showAllLabel").hidden = focusing;
  document.querySelector("#sectionTitle").textContent = driver
    ? driver.full_name
    : "Per driver";
}

// Arriving from a driver's row is a detour out of the Drivers tab, so that is
// the one that stays lit while the detour is open — the menu entry belongs to
// the store-wide view. Settled before the report is fetched: which tab is lit
// depends on the URL alone, and a slow or failed load must not leave the wrong
// one underlined.
function markActiveTab() {
  const focusing = focusDriverId !== null;
  document.querySelector("#navPerformance").classList.toggle("active", !focusing);
  document.querySelector("#navDrivers").classList.toggle("active", focusing);
}

/* ===========================
   EXPORT
=========================== */

// A flat file for whoever keeps the books. Same figures as the cards, one row
// per driver plus the store total, so the sheet can be filed against the cash
// that was actually counted.
function exportCsv() {
  if (!report) return;

  const header = [
    "Driver",
    "Phone",
    "Delivered",
    "Returned",
    "Prepaid deliveries",
    "Cash collected",
    "Prepaid value",
    "Pay owed",
    "Cash to hand in",
    "Still out",
    "Cash still out",
    "First delivery",
    "Last delivery",
    "Avg minutes",
  ];

  // The file matches the view: one driver when focused on one, otherwise
  // everyone who did something. Exporting the whole roster from a single
  // driver's page would file the wrong sheet against the counted cash.
  const focused = focusedDriver();
  const exported = focused
    ? [focused]
    : report.drivers.filter(
        (d) => d.delivered > 0 || d.returned > 0 || d.orders_out > 0
      );

  const rows = exported
    .map((d) => [
      d.full_name,
      d.phone ?? "",
      d.delivered,
      d.returned,
      d.prepaid_deliveries,
      d.cash_collected.toFixed(2),
      d.prepaid_value.toFixed(2),
      d.pay_owed.toFixed(2),
      d.cash_to_hand_in.toFixed(2),
      d.orders_out,
      d.cash_out.toFixed(2),
      d.first_delivery_at ?? "",
      d.last_delivery_at ?? "",
      d.avg_minutes_to_deliver ?? "",
    ]);

  // Skipped when focused on one driver: their row is already the total, and a
  // second line repeating it invites double-counting when the sheet is added up.
  const t = report.totals;
  if (!focused) rows.push([
    "TOTAL",
    "",
    t.delivered,
    t.returned,
    t.prepaid_deliveries,
    t.cash_collected.toFixed(2),
    t.prepaid_value.toFixed(2),
    t.pay_owed.toFixed(2),
    t.cash_to_hand_in.toFixed(2),
    t.orders_out,
    t.cash_out.toFixed(2),
    "",
    "",
    "",
  ]);

  // The two figures the sheet is filed for, spelled out rather than left to be
  // read off the TOTAL row: that row nets a driver the store owes against the
  // ones bringing cash in, and the notes counted at the table do not net.
  if (!focused) {
    // Written into the "Cash to hand in" column so the amount lands under the
    // figures it belongs with instead of starting a column of its own.
    const summaryRow = (label, amount) => {
      const row = header.map(() => "");
      row[0] = label;
      row[header.indexOf("Cash to hand in")] = amount.toFixed(2);
      return row;
    };

    rows.push(summaryRow("TO COLLECT FROM DRIVERS", t.to_collect));
    if (t.to_pay_out > 0) {
      rows.push(summaryRow("TO PAY OUT TO DRIVERS", t.to_pay_out));
    }
  }

  const csv = [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");

  // A leading BOM so Excel opens the file as UTF-8 — driver names carry Arabic
  // and French characters that would otherwise arrive as mojibake.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  // Names carry spaces and accents that make awkward filenames, so the name is
  // reduced to something a filesystem and an email attachment both accept.
  const who = focused
    ? focused.full_name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()
    : "all";
  link.download = `driver-performance-${who}-${report.from}_to_${report.to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* ===========================
   WIRING
=========================== */

document.querySelectorAll(".period-btn").forEach((button) => {
  button.addEventListener("click", () => load(presetRange(button.dataset.preset)));
});

document.querySelector("#applyRange").addEventListener("click", () => {
  const from = fromInput.value;
  const to = toInput.value;
  if (!from || !to) {
    showToast("Pick both a start and an end date.", "error");
    return;
  }
  if (from > to) {
    showToast("The start date must come before the end date.", "error");
    return;
  }
  load({ from, to });
});

showAllEl.addEventListener("change", () => {
  if (!report) return;
  // The table and the cards answer to the same checkbox — a roster that
  // disagreed with the list under it would be read as two different rosters.
  renderCollection();
  renderDrivers();
});

markActiveTab();

document.querySelector("#exportBtn").addEventListener("click", exportCsv);
document.querySelector("#printBtn").addEventListener("click", () => window.print());

// No range on the first call: the backend answers for the store's own today,
// which is the only party that knows which day that is.
load();
