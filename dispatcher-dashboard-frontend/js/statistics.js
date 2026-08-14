// The Statistics page: how the delivery operation is doing, over a period the
// dispatcher chooses.
//
// The Performance page answers "what do I hand this driver tonight". This one
// answers the questions that come after that: is the shop getting busier, when
// is the fleet actually needed, how long does a delivery really take, where are
// the orders going, and which of them never make it.
//
// Two rules keep the page honest:
//
//   1. No arithmetic that the backend has not already done. Everything drawn
//      here comes off the report as a finished figure, so this page, the
//      Performance page and the CSV can never show three answers for one day.
//      The only numbers computed in this file are the period-over-period
//      deltas, which are a ratio of two figures the backend sent.
//
//   2. Every chart is shown against the window before it. A number on its own
//      is not information: "142 deliveries" only means something beside last
//      week's 118, so every tile carries its own comparison and says which
//      period it is comparing against.
//
// Charts are drawn by js/charts.js, which explains why they are hand-drawn SVG
// rather than a library, and holds the rules they are all drawn by.

import { getStatistics } from "./api.js";
import { showToast } from "./ui.js";
import {
  lineChart,
  columnChart,
  barChart,
  stackedBar,
  sparkline,
  legend,
  dataTable,
  SERIES_COLORS,
  STATUS_COLORS,
  ORDINAL_BLUES,
  compact,
} from "./charts.js";

const fromInput = document.querySelector("#fromDate");
const toInput = document.querySelector("#toDate");
const periodSummaryEl = document.querySelector("#periodSummary");

// The report currently on screen. Held so the CSV export writes exactly what
// the dispatcher is looking at rather than re-fetching and risking a different
// answer between the two.
let report = null;

/* ===========================
   FORMATTING
=========================== */

// Money is shown to two decimals wherever it is a figure to be acted on, and
// compacted on axes, where the size is what is being read rather than the cent.
function money(value) {
  const amount = Number(value) || 0;
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function moneyCompact(value) {
  const amount = Number(value) || 0;
  return `${amount < 0 ? "-" : ""}$${compact(Math.abs(amount))}`;
}

function count(value) {
  return (Number(value) || 0).toLocaleString("en-US");
}

function percent(value) {
  return value === null || value === undefined ? "—" : `${value}%`;
}

function minutesLabel(minutes) {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// "2026-08-14" → "Aug 14". Built from the string rather than from a Date so the
// label cannot slide a day when the browser sits in a different timezone from
// the store.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(isoDate) {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}`;
}

function longDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/* ===========================
   DATE RANGE
=========================== */

// Calendar dates are treated as plain strings and shifted through UTC, never
// through the local calendar: adding a day must not depend on which side of a
// daylight-saving change the browser happens to be on.
function shiftDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// Today where the store is. The report's timezone is the authority — a manager
// reading this from another country is still reading the store's day.
function storeToday() {
  const timeZone = report ? report.timezone : undefined;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA").format(new Date());
  }
}

// Monday-first, matching the driver app and the Performance page.
function weekStart(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return shiftDays(isoDate, -weekday);
}

function presetRange(preset) {
  const today = storeToday();

  if (preset === "week") return { from: weekStart(today), to: today };
  if (preset === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  // The rolling windows include today, so "last 7 days" is this day and the six
  // before it — which is what someone comparing to last week means by it.
  if (preset === "last7") return { from: shiftDays(today, -6), to: today };
  if (preset === "last30") return { from: shiftDays(today, -29), to: today };
  if (preset === "last90") return { from: shiftDays(today, -89), to: today };
  return { from: today, to: today };
}

function describeRange(from, to) {
  const today = storeToday();
  if (from === to) {
    if (from === today) return "Today";
    if (from === shiftDays(today, -1)) return "Yesterday";
    return longDate(from);
  }
  return `${longDate(from)} → ${longDate(to)}`;
}

function markActivePreset() {
  document.querySelectorAll(".period-btn").forEach((button) => {
    const range = presetRange(button.dataset.preset);
    button.classList.toggle(
      "period-btn-active",
      range.from === report.from && range.to === report.to
    );
  });
}

/* ===========================
   DELTAS
=========================== */

// The change against the window before, as a signed percentage. The direction
// is not always good news — returns going up is bad — so which way is good is
// stated per tile rather than assumed from the sign.
//
// Returns null when there is nothing to compare against: a previous period of
// zero makes every increase "+∞%", which tells a reader nothing they can use.
function deltaOf(current, previous) {
  const now = Number(current) || 0;
  const before = Number(previous) || 0;
  if (!before) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

// One tile. `good` says which direction is the good one, so the colour means
// "better/worse" rather than "up/down" — a rise in returns is painted red.
//
// "neutral" is the third answer, and it matters: driver pay rises because
// deliveries rose, and painting that red would tell the reader the best day of
// the month went badly. A figure that only moves because a good figure moved is
// reported as movement, not as a verdict.
function statTile({ label, value, sub, delta, good = "up", spark, accent }) {
  const card = document.createElement("div");
  card.className = "kpi-card";

  const title = document.createElement("p");
  title.className = "stat-title";
  title.textContent = label;

  const figure = document.createElement("p");
  figure.className = "kpi-value";
  if (accent) figure.classList.add(`kpi-value-${accent}`);
  figure.textContent = value;

  card.append(title, figure);

  if (delta !== null && delta !== undefined) {
    const badge = document.createElement("p");
    const neutral = good === "neutral";
    const better = good === "up" ? delta > 0 : delta < 0;
    const flat = delta === 0;
    badge.className = `kpi-delta ${
      flat || neutral ? "kpi-delta-flat" : better ? "kpi-delta-up" : "kpi-delta-down"
    }`;
    // The arrow says which way the number moved; the colour says whether that
    // is good. Both are spelled out in words so neither is carried by colour
    // alone — and where there is no good direction, no verdict is given.
    badge.textContent = flat
      ? "No change vs previous period"
      : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}% ${
          neutral ? "vs" : better ? "better than" : "worse than"
        } previous period`;
    card.appendChild(badge);
  } else {
    // Said out loud rather than left blank. A tile with no comparison line
    // reads as an oversight, and the tiles beside it would sit at a different
    // height for no reason the reader can see.
    const badge = document.createElement("p");
    badge.className = "kpi-delta kpi-delta-flat";
    badge.textContent = "Nothing to compare in the previous period";
    card.appendChild(badge);
  }

  if (sub) {
    const note = document.createElement("p");
    note.className = "stat-note";
    note.textContent = sub;
    card.appendChild(note);
  }

  if (spark && spark.length > 1) {
    const holder = document.createElement("div");
    holder.className = "kpi-spark";
    holder.appendChild(sparkline(spark, { accent: SERIES_COLORS[0] }));
    card.appendChild(holder);
  }

  return card;
}

/* ===========================
   HERO AND TILES
=========================== */

function renderHero() {
  const now = report.summary;
  const before = report.previous;
  const delta = deltaOf(now.revenue, before.revenue);

  document.querySelector("#heroValue").textContent = money(now.revenue);

  const parts = [
    `${count(now.delivered)} deliveries completed`,
    `${describeRange(report.from, report.to)}`,
  ];
  if (delta !== null) {
    parts.push(
      `${delta >= 0 ? "up" : "down"} ${Math.abs(delta)}% on ${money(before.revenue)} in the ${report.days === 1 ? "day" : `${report.days} days`} before`
    );
  }
  document.querySelector("#heroSub").textContent = parts.join(" · ");

  const spark = document.querySelector("#heroSpark");
  spark.innerHTML = "";
  if (report.daily.length > 1) {
    spark.appendChild(
      sparkline(report.daily.map((day) => day.revenue), { width: 190, height: 54 })
    );
  }

  // The two halves of the headline figure, because they are settled in
  // completely different ways: one is notes in a bag, the other arrived before
  // the driver ever set off.
  const splits = document.querySelector("#heroSplits");
  splits.innerHTML = "";
  splits.append(
    heroSplit("Cash collected at the door", money(now.cash_collected), SERIES_COLORS[0]),
    heroSplit("Paid online before delivery", money(now.prepaid_value), SERIES_COLORS[1]),
    heroSplit("Owed to drivers", money(now.driver_pay), SERIES_COLORS[3])
  );
}

function heroSplit(label, value, color) {
  const block = document.createElement("div");
  block.className = "hero-split";

  const swatch = document.createElement("span");
  swatch.className = "viz-legend-swatch";
  swatch.style.background = color;

  const title = document.createElement("p");
  title.className = "stat-title";
  title.append(swatch, document.createTextNode(label));

  const figure = document.createElement("p");
  figure.className = "hero-split-value";
  figure.textContent = value;

  block.append(title, figure);
  return block;
}

function renderTiles() {
  const now = report.summary;
  const before = report.previous;
  const grid = document.querySelector("#kpiGrid");
  grid.innerHTML = "";

  document.querySelector("#kpiLead").textContent =
    `Every tile is measured against ${longDate(report.previous.from)} → ${longDate(report.previous.to)}, ` +
    `the ${report.days === 1 ? "day" : `${report.days} days`} immediately before this period.`;

  const daily = report.daily;
  const spark = (key) => daily.map((day) => day[key]);

  grid.append(
    statTile({
      label: "Orders placed",
      value: count(now.placed),
      sub: `${money(now.placed_value)} of orders arrived`,
      delta: deltaOf(now.placed, before.placed),
      spark: spark("placed"),
    }),
    statTile({
      label: "Deliveries completed",
      value: count(now.delivered),
      sub: `${count(now.drivers_active)} driver${now.drivers_active === 1 ? "" : "s"} worked`,
      delta: deltaOf(now.delivered, before.delivered),
      spark: spark("delivered"),
    }),
    statTile({
      label: "Cash collected",
      value: money(now.cash_collected),
      sub: `${count(now.delivered - now.prepaid_deliveries)} orders paid at the door`,
      delta: deltaOf(now.cash_collected, before.cash_collected),
      spark: spark("cash"),
    }),
    statTile({
      label: "Average order value",
      value: now.avg_order_value === null ? "—" : money(now.avg_order_value),
      sub: "Per completed delivery",
      delta: deltaOf(now.avg_order_value, before.avg_order_value),
    }),
    statTile({
      label: "Delivered first time",
      value: percent(now.success_rate),
      sub: `${count(now.delivered)} delivered · ${count(now.returned)} came back`,
      delta: deltaOf(now.success_rate, before.success_rate),
      accent: "good",
    }),
    statTile({
      label: "Returns",
      value: count(now.returned),
      sub: `${money(now.returned_value)} of goods came back`,
      // Fewer is better here, which is why the direction is stated rather than
      // inferred from the sign.
      delta: deltaOf(now.returned, before.returned),
      good: "down",
      accent: "bad",
    }),
    statTile({
      label: "Typical delivery time",
      value: minutesLabel(now.median_minutes),
      sub:
        now.timed_deliveries > 0
          ? `Median of ${count(now.timed_deliveries)} timed trips · slowest tenth over ${minutesLabel(now.p90_minutes)}`
          : "No trips were timed in this period",
      delta: deltaOf(now.median_minutes, before.median_minutes),
      good: "down",
    }),
    statTile({
      label: "Deliveries per driver",
      value: now.deliveries_per_driver === null ? "—" : String(now.deliveries_per_driver),
      sub: "Among the drivers who worked",
      delta: deltaOf(now.deliveries_per_driver, before.deliveries_per_driver),
    }),
    statTile({
      label: "Paid online",
      value: percent(now.prepaid_share),
      sub: `${count(now.prepaid_deliveries)} deliveries brought back no cash (${money(now.prepaid_value)})`,
      // How customers choose to pay is not something the shop is doing well or
      // badly at, so the tile reports the shift without grading it.
      delta: deltaOf(now.prepaid_share, before.prepaid_share),
      good: "neutral",
    }),
    statTile({
      label: "Owed to drivers",
      value: money(now.driver_pay),
      sub: `${count(now.delivered)} × ${money(report.fee_per_delivery)} per delivery`,
      // A flat fee per delivery: this rises precisely because deliveries rose,
      // and calling the busiest month of the year "worse" would be nonsense.
      delta: deltaOf(now.driver_pay, before.driver_pay),
      good: "neutral",
    })
  );
}

/* ===========================
   THE CHARTS
=========================== */

function renderTrend() {
  const daily = report.daily;
  const series = [
    {
      key: "placed",
      label: "Orders placed",
      color: SERIES_COLORS[0],
      values: daily.map((day) => day.placed),
    },
    {
      key: "delivered",
      label: "Deliveries completed",
      color: SERIES_COLORS[2],
      values: daily.map((day) => day.delivered),
    },
    {
      key: "returned",
      label: "Returned",
      color: SERIES_COLORS[1],
      values: daily.map((day) => day.returned),
    },
  ];

  lineChart(document.querySelector("#trendChart"), {
    labels: daily.map((day) => `${day.weekday} ${shortDate(day.day)}`),
    tickLabels: daily.map((day) => shortDate(day.day)),
    series,
    format: count,
    axisFormat: compact,
    height: 300,
    ariaLabel: "Orders placed, deliveries completed and returns per day",
  });

  document.querySelector("#trendLegend").replaceChildren(
    legend(
      series.map((line) => ({
        label: line.label,
        color: line.color,
        value: count(line.values.reduce((sum, value) => sum + value, 0)),
      }))
    )
  );

  fillTable(
    "trendTable",
    ["Day", "Placed", "Completed", "Returned"],
    daily.map((day) => [
      `${day.weekday} ${shortDate(day.day)}`,
      count(day.placed),
      count(day.delivered),
      count(day.returned),
    ])
  );
}

function renderMoney() {
  const daily = report.daily;
  const series = [
    {
      key: "revenue",
      label: "Revenue delivered",
      color: SERIES_COLORS[0],
      values: daily.map((day) => day.revenue),
    },
    {
      key: "cash",
      label: "Of which cash at the door",
      color: SERIES_COLORS[3],
      values: daily.map((day) => day.cash),
    },
  ];

  lineChart(document.querySelector("#moneyChart"), {
    labels: daily.map((day) => `${day.weekday} ${shortDate(day.day)}`),
    tickLabels: daily.map((day) => shortDate(day.day)),
    series,
    format: money,
    axisFormat: moneyCompact,
    height: 280,
    ariaLabel: "Revenue and cash collected per day",
  });

  document.querySelector("#moneyLegend").replaceChildren(
    legend(
      series.map((line) => ({
        label: line.label,
        color: line.color,
        value: money(line.values.reduce((sum, value) => sum + value, 0)),
      }))
    )
  );

  fillTable(
    "moneyTable",
    ["Day", "Revenue", "Cash", "Paid online"],
    daily.map((day) => [
      `${day.weekday} ${shortDate(day.day)}`,
      money(day.revenue),
      money(day.cash),
      money(Math.round((day.revenue - day.cash) * 100) / 100),
    ])
  );
}

function renderHourly() {
  const hours = report.hourly;

  columnChart(document.querySelector("#hourlyChart"), {
    bars: hours.map((hour) => ({
      label: hour.label,
      tooltipLabel: `${hour.label} – ${hours[(hour.hour + 1) % 24].label}`,
      value: hour.delivered,
      note: { label: "Revenue", value: money(hour.revenue) },
    })),
    valueLabel: "Deliveries",
    format: count,
    height: 250,
    ariaLabel: "Deliveries completed by hour of the day",
  });

  const busiest = hours.reduce((best, hour) => (hour.delivered > best.delivered ? hour : best), hours[0]);
  const total = hours.reduce((sum, hour) => sum + hour.delivered, 0);
  document.querySelector("#hourlyNote").textContent = total
    ? `Busiest hour: ${busiest.label} with ${count(busiest.delivered)} deliveries, ` +
      `${Math.round((busiest.delivered / total) * 100)}% of the period's work.`
    : "No deliveries were completed in this period.";

  fillTable(
    "hourlyTable",
    ["Hour", "Deliveries", "Revenue"],
    hours.map((hour) => [hour.label, count(hour.delivered), money(hour.revenue)])
  );
}

function renderWeekday() {
  const days = report.weekday;

  columnChart(document.querySelector("#weekdayChart"), {
    bars: days.map((day) => ({
      label: day.label,
      value: day.delivered,
      note: { label: "Revenue", value: money(day.revenue) },
    })),
    valueLabel: "Deliveries",
    format: count,
    height: 250,
    ariaLabel: "Deliveries completed by day of the week",
  });

  const total = days.reduce((sum, day) => sum + day.delivered, 0);
  const busiest = days.reduce((best, day) => (day.delivered > best.delivered ? day : best), days[0]);
  document.querySelector("#weekdayNote").textContent = total
    ? `${busiest.label} is the busiest day of the week here, with ${count(busiest.delivered)} of the period's ${count(total)} deliveries.`
    : "No deliveries were completed in this period.";

  fillTable(
    "weekdayTable",
    ["Weekday", "Deliveries", "Returned", "Revenue"],
    days.map((day) => [day.label, count(day.delivered), count(day.returned), money(day.revenue)])
  );
}

function renderDurations() {
  const buckets = report.durations;
  const total = buckets.reduce((sum, bucket) => sum + bucket.deliveries, 0);

  columnChart(document.querySelector("#durationChart"), {
    bars: buckets.map((bucket) => ({
      label: bucket.label,
      value: bucket.deliveries,
      note: {
        label: "Share of timed trips",
        value: total ? `${Math.round((bucket.deliveries / total) * 100)}%` : "—",
      },
    })),
    valueLabel: "Deliveries",
    format: count,
    height: 250,
    ariaLabel: "How long deliveries took, counted into buckets",
  });

  const summary = report.summary;
  const untimed = summary.delivered - total;
  const note = document.querySelector("#durationNote");

  if (!total) {
    note.textContent =
      "No trips in this period were timed, so there is nothing to measure. A trip is timed when the driver taps Start Delivery.";
  } else {
    // The untimed deliveries are only mentioned when there are some. Saying
    // "527 of 527, the rest were never started" is the kind of sentence that
    // makes a reader distrust every other number on the page.
    note.textContent =
      `Median ${minutesLabel(summary.median_minutes)} · average ${minutesLabel(summary.avg_minutes)} · ` +
      `the slowest tenth took over ${minutesLabel(summary.p90_minutes)}. ` +
      (untimed > 0
        ? `Based on ${count(total)} of ${count(summary.delivered)} deliveries — the other ${count(untimed)} were never started on the record, so they have no measurable length.`
        : `Based on all ${count(total)} deliveries in the period.`);
  }

  fillTable(
    "durationTable",
    ["Trip length", "Deliveries", "Share"],
    buckets.map((bucket) => [
      bucket.label,
      count(bucket.deliveries),
      total ? `${Math.round((bucket.deliveries / total) * 100)}%` : "—",
    ])
  );
}

function renderFunnel() {
  const funnel = report.funnel;
  const stages = [
    { label: "Placed", value: funnel.placed },
    { label: "Assigned to a driver", value: funnel.assigned },
    { label: "Driver set off", value: funnel.started },
    { label: "Delivered", value: funnel.delivered },
  ];

  barChart(document.querySelector("#funnelChart"), {
    // An ordered ramp rather than four identities: these stages have a natural
    // order, and darker-as-you-go-deeper reads as progress through it.
    rows: stages.map((stage, index) => ({
      label: stage.label,
      value: stage.value,
      color: ORDINAL_BLUES[index],
      notes: [
        {
          label: "Of orders placed",
          value: funnel.placed ? `${Math.round((stage.value / funnel.placed) * 100)}%` : "—",
        },
      ],
    })),
    valueLabel: "Orders",
    format: count,
    rowHeight: 40,
    ariaLabel: "Orders placed, assigned, started and delivered",
  });

  const lost = funnel.placed - funnel.delivered;
  document.querySelector("#funnelNote").textContent = funnel.placed
    ? `${Math.round((funnel.delivered / funnel.placed) * 100)}% of the orders placed in this period have been delivered. ` +
      `Of the ${count(lost)} that have not: ${count(funnel.returned)} came back, ${count(funnel.cancelled)} were cancelled, ` +
      `and ${count(funnel.open)} are still open.`
    : "No orders were placed in this period.";

  fillTable(
    "funnelTable",
    ["Stage", "Orders", "Of orders placed"],
    stages.map((stage) => [
      stage.label,
      count(stage.value),
      funnel.placed ? `${Math.round((stage.value / funnel.placed) * 100)}%` : "—",
    ])
  );
}

function renderOutcome() {
  const funnel = report.funnel;
  // Status colours, not series colours: these mean good, waiting and bad, and a
  // status colour must never turn up as somebody's identity. Each one carries
  // its written label in the legend, so the meaning is never colour alone.
  const segments = [
    { label: "Delivered", value: funnel.delivered, color: STATUS_COLORS.good },
    { label: "Still open", value: funnel.open, color: STATUS_COLORS.warning },
    { label: "Returned", value: funnel.returned, color: STATUS_COLORS.serious },
    { label: "Cancelled", value: funnel.cancelled, color: STATUS_COLORS.critical },
  ];

  stackedBar(document.querySelector("#outcomeChart"), {
    segments,
    valueLabel: "Orders",
    format: count,
    ariaLabel: "What became of the orders placed in this period",
  });

  document.querySelector("#outcomeLegend").replaceChildren(
    legend(segments.map((segment) => ({ ...segment, value: count(segment.value) })))
  );

  fillTable(
    "outcomeTable",
    ["Outcome", "Orders", "Share"],
    segments.map((segment) => [
      segment.label,
      count(segment.value),
      funnel.placed ? `${Math.round((segment.value / funnel.placed) * 100)}%` : "—",
    ])
  );
}

function renderPayment() {
  const mix = report.payment_mix;
  const segments = [
    { label: "Cash at the door", value: mix.cash_value, color: SERIES_COLORS[0] },
    { label: "Paid online", value: mix.prepaid_value, color: SERIES_COLORS[1] },
  ];

  stackedBar(document.querySelector("#paymentChart"), {
    segments,
    valueLabel: "Value",
    format: money,
    ariaLabel: "Revenue split between cash collected and orders paid online",
  });

  document.querySelector("#paymentLegend").replaceChildren(
    legend([
      {
        label: `Cash at the door · ${count(mix.cash_deliveries)} deliveries`,
        color: SERIES_COLORS[0],
        value: money(mix.cash_value),
      },
      {
        label: `Paid online · ${count(mix.prepaid_deliveries)} deliveries`,
        color: SERIES_COLORS[1],
        value: money(mix.prepaid_value),
      },
    ])
  );

  fillTable(
    "paymentTable",
    ["How it was paid", "Deliveries", "Value"],
    [
      ["Cash at the door", count(mix.cash_deliveries), money(mix.cash_value)],
      ["Paid online", count(mix.prepaid_deliveries), money(mix.prepaid_value)],
    ]
  );
}

function renderPlaces() {
  renderPlace("#areaChart", "areasTable", report.areas, "Area");
  renderPlace("#cityChart", "citiesTable", report.cities, "City");
}

function renderPlace(chartSelector, tableId, rows, heading) {
  const container = document.querySelector(chartSelector);

  if (!rows.length) {
    container.replaceChildren(emptyNote("No deliveries were completed in this period."));
    fillTable(tableId, [heading, "Delivered"], []);
    return;
  }

  barChart(container, {
    // One hue for every bar: these categories have no order of their own, so
    // shading them by size would say the same thing the bar length already does.
    rows: rows.map((row) => ({
      label: row.name,
      value: row.delivered,
      notes: [
        { label: "Revenue", value: money(row.revenue) },
        { label: "Cash", value: money(row.cash) },
        { label: "Returned", value: count(row.returned) },
        { label: "Avg trip", value: minutesLabel(row.avg_minutes) },
      ],
    })),
    valueLabel: "Deliveries",
    format: count,
    ariaLabel: `Deliveries by ${heading.toLowerCase()}`,
  });

  fillTable(
    tableId,
    [heading, "Delivered", "Returned", "Revenue", "Cash", "Avg trip"],
    rows.map((row) => [
      row.name,
      count(row.delivered),
      count(row.returned),
      money(row.revenue),
      money(row.cash),
      minutesLabel(row.avg_minutes),
    ])
  );
}

function renderDrivers() {
  const drivers = report.drivers;
  const container = document.querySelector("#driverChart");

  if (!drivers.length) {
    container.replaceChildren(emptyNote("No driver completed a delivery in this period."));
    fillTable("driversTable", ["Driver", "Delivered"], []);
    return;
  }

  barChart(container, {
    rows: drivers.map((driver) => ({
      label: driver.full_name,
      value: driver.delivered,
      notes: [
        { label: "Cash collected", value: money(driver.cash_collected) },
        { label: "Returned", value: count(driver.returned) },
        { label: "Avg trip", value: minutesLabel(driver.avg_minutes_to_deliver) },
        { label: "Pay owed", value: money(driver.pay_owed) },
      ],
    })),
    valueLabel: "Deliveries",
    format: count,
    rowHeight: 34,
    ariaLabel: "Deliveries completed by each driver",
  });

  fillTable(
    "driversTable",
    ["Driver", "Delivered", "Returned", "Cash collected", "Paid online", "Avg trip", "Pay owed"],
    drivers.map((driver) => [
      driver.full_name,
      count(driver.delivered),
      count(driver.returned),
      money(driver.cash_collected),
      money(driver.prepaid_value),
      minutesLabel(driver.avg_minutes_to_deliver),
      money(driver.pay_owed),
    ])
  );
}

function renderLive() {
  const live = report.live;
  const grid = document.querySelector("#liveGrid");
  grid.innerHTML = "";

  const tiles = [
    ["Waiting for a driver", count(live.unassigned), "Nobody has been given these yet"],
    ["With a driver, not started", count(live.assigned), "Assigned but the trip has not begun"],
    ["On the road", count(live.on_the_road), "Drivers are out with these now"],
    ["Cash on the road", money(live.cash_on_the_road), "Not collected yet"],
    ["Open order value", money(live.open_value), `${count(live.open_orders)} orders still open`],
  ];

  for (const [label, value, note] of tiles) {
    const card = document.createElement("div");
    card.className = "stat-card";

    const title = document.createElement("p");
    title.className = "stat-title";
    title.textContent = label;

    const figure = document.createElement("h3");
    figure.textContent = value;

    const sub = document.createElement("p");
    sub.className = "stat-note";
    sub.textContent = note;

    card.append(title, figure, sub);
    grid.appendChild(card);
  }
}

function renderDailyTable() {
  const wrap = document.querySelector("#dailyTable");
  wrap.replaceChildren(
    dataTable(
      ["Day", "Placed", "Order value", "Delivered", "Returned", "Revenue", "Cash"],
      report.daily.map((day) => [
        `${day.weekday} ${shortDate(day.day)}`,
        count(day.placed),
        money(day.placed_value),
        count(day.delivered),
        count(day.returned),
        money(day.revenue),
        money(day.cash),
      ])
    )
  );
}

/* ===========================
   SHARED PIECES
=========================== */

function emptyNote(message) {
  const note = document.createElement("p");
  note.className = "empty-note";
  note.textContent = message;
  return note;
}

// Every chart has a table twin holding the same numbers — for a screen reader,
// for anyone who cannot separate the colours, and for the dispatcher who wants
// the figure rather than the picture.
function fillTable(id, columns, rows) {
  const wrap = document.querySelector(`#${id}`);
  if (!wrap) return;
  wrap.replaceChildren(
    rows.length ? dataTable(columns, rows) : emptyNote("Nothing to show for this period.")
  );
}

// The toggles are wired once, by delegation, rather than per card: the cards
// are static markup and every one of them behaves the same way.
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-table-toggle]");
  if (!button) return;

  const card = button.closest(".viz-card");
  const tables = card.querySelectorAll(".viz-table-wrap");
  const plots = card.querySelectorAll(".viz-plot");
  const showingTable = button.getAttribute("aria-pressed") === "true";

  tables.forEach((table) => (table.hidden = showingTable));
  plots.forEach((plot) => (plot.hidden = !showingTable));
  card.querySelectorAll(".viz-legend").forEach((list) => (list.hidden = !showingTable));

  button.setAttribute("aria-pressed", String(!showingTable));
  button.textContent = showingTable ? "Show table" : "Show chart";
});

/* ===========================
   EXPORT
=========================== */

// The day-by-day sheet, plus the period's headline figures at the top so the
// file can be read on its own months later without anyone having to remember
// which window it was exported for.
function exportCsv() {
  if (!report) return;

  const summary = report.summary;
  const rows = [
    ["Live Dispatch — statistics"],
    ["Period", `${report.from} to ${report.to}`, `${report.days} days`, report.timezone],
    ["Compared against", `${report.previous.from} to ${report.previous.to}`],
    [],
    ["Orders placed", summary.placed],
    ["Order value placed", summary.placed_value.toFixed(2)],
    ["Deliveries completed", summary.delivered],
    ["Returns", summary.returned],
    ["Revenue delivered", summary.revenue.toFixed(2)],
    ["Cash collected", summary.cash_collected.toFixed(2)],
    ["Paid online", summary.prepaid_value.toFixed(2)],
    ["Owed to drivers", summary.driver_pay.toFixed(2)],
    ["Delivered first time (%)", summary.success_rate ?? ""],
    ["Median delivery time (minutes)", summary.median_minutes ?? ""],
    ["Drivers who worked", summary.drivers_active],
    [],
    ["Day", "Weekday", "Placed", "Order value", "Delivered", "Returned", "Revenue", "Cash"],
    ...report.daily.map((day) => [
      day.day,
      day.weekday,
      day.placed,
      day.placed_value.toFixed(2),
      day.delivered,
      day.returned,
      day.revenue.toFixed(2),
      day.cash.toFixed(2),
    ]),
  ];

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");

  // A leading BOM so Excel opens the file as UTF-8 — city and driver names
  // carry Arabic and French characters that would otherwise arrive as mojibake.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `statistics-${report.from}_to_${report.to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* ===========================
   LOADING
=========================== */

const CHARTS = [
  renderTrend,
  renderMoney,
  renderHourly,
  renderWeekday,
  renderDurations,
  renderFunnel,
  renderOutcome,
  renderPayment,
  renderPlaces,
  renderDrivers,
];

async function load(range) {
  const main = document.querySelector(".main-content");
  // The previous render is held at reduced opacity rather than being replaced
  // by a skeleton: the page is tall, and blanking it on every date change would
  // throw the reader's place away along with the numbers.
  main.classList.add("is-loading");

  try {
    report = await getStatistics(range);
  } catch (error) {
    console.error("Failed to load statistics:", error);
    showToast("Could not load the statistics report.", "error");
    return;
  } finally {
    main.classList.remove("is-loading");
  }

  // The response is the authority on the period, not the inputs: an omitted
  // range comes back resolved to the store's today, and the fields have to
  // follow so the next Apply starts from what is on screen.
  fromInput.value = report.from;
  toInput.value = report.to;

  periodSummaryEl.textContent =
    `${describeRange(report.from, report.to)} — ${report.days} day${report.days === 1 ? "" : "s"}, ` +
    `${report.from} to ${report.to} (${report.timezone}). ` +
    `Compared against ${report.previous.from} to ${report.previous.to}.`;

  document.querySelector("#hourTimezone").textContent = report.timezone;

  markActivePreset();
  renderHero();
  renderTiles();
  CHARTS.forEach((render) => render());
  renderLive();
  renderDailyTable();
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

document.querySelector("#exportBtn").addEventListener("click", exportCsv);
document.querySelector("#printBtn").addEventListener("click", () => window.print());

// The page opens on the last 30 days rather than on today: a single day has no
// shape to it — one point on every line, and histograms built from a handful of
// deliveries. Asked for as a length rather than as two dates, because only the
// backend knows which day "today" is where the store is standing.
load({ days: 30 });
