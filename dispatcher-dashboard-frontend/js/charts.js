// charts.js
//
// The drawing kit behind the Statistics page: line, column, bar, stacked bar
// and sparkline, rendered as plain SVG.
//
// Why by hand rather than with a charting library:
//
//   • The dashboard ships no build step and no package manager. A library would
//     have to arrive from a CDN, and the app's Content-Security-Policy (see
//     app.js) allows scripts from 'self' and Google Maps only. Widening it for
//     a bar chart is not a trade worth making.
//   • Everything here is one screen of geometry per chart type. The whole file
//     is smaller than the library's own loader would be.
//
// House rules, applied by every renderer below rather than left to each caller:
//
//   • Marks are thin (bars capped at 24px, lines 2px), data-ends are rounded by
//     4px and square at the baseline, and touching fills are separated by a 2px
//     gap in the surface colour rather than by a border.
//   • Gridlines and axes are solid hairlines one step off the surface. Never
//     dashed — a dashed grid reads as a threshold that is not there.
//   • Text never wears the series colour. Identity comes from the swatch beside
//     the label; the words themselves stay in the page's ink colours, because a
//     light categorical hue is illegible as text on white.
//   • Values are labelled selectively — the end of a line, the tip of a bar —
//     never on every point, and never where the label would not fit.
//   • Every chart is hoverable and keyboard-reachable, and every chart on the
//     page has a table twin. A tooltip enhances a value; it never gates it.
//
// The palette is the validated categorical set: adjacent slots are far enough
// apart under protanopia, deuteranopia and tritanopia to stay distinguishable,
// which is why the slots are assigned in a fixed order and never cycled. Three
// of them fall below 3:1 against white, which is exactly why the direct labels
// and the table twin above are not optional.

export const SERIES_COLORS = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
];

// Reserved for state, never for identity: a status colour must not turn up as
// "series 4". Each one is always shown with its own written label.
export const STATUS_COLORS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
};

// One hue, light to dark, for ordered stages. Starts at a step that still
// clears 2:1 against white so the first stage is not a ghost.
export const ORDINAL_BLUES = ["#86b6ef", "#5598e7", "#2a78d6", "#184f95"];

const INK = {
  surface: "#ffffff",
  primary: "#111827",
  secondary: "#4b5563",
  muted: "#6b7280",
  faint: "#9ca3af",
  grid: "#e5e7eb",
  axis: "#d1d5db",
  // The context colour: everything that is not the point of the chart.
  quiet: "#cbd5e1",
};

const NS = "http://www.w3.org/2000/svg";

/* ===========================
   SVG PLUMBING
=========================== */

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

// Text is always written with textContent — labels carry city names, driver
// names and order numbers, none of which are safe to hand to a parser.
function text(value, attrs = {}) {
  const node = el("text", {
    "font-size": 12,
    fill: INK.muted,
    "font-family": "Arial, sans-serif",
    ...attrs,
  });
  node.textContent = value;
  return node;
}

// A rectangle with its data-end rounded and its baseline end square, drawn as a
// path because SVG's rx rounds all four corners. `side` is which end grows.
function barPath(x, y, width, height, radius, side) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (height <= 0 || width <= 0) return "";

  if (side === "top") {
    return `M${x} ${y + height} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} L${x + width - r} ${y} Q${x + width} ${y} ${x + width} ${y + r} L${x + width} ${y + height} Z`;
  }
  if (side === "left") {
    // The left-hand end of a stacked bar: rounded away from its neighbour.
    return `M${x + width} ${y} L${x + r} ${y} Q${x} ${y} ${x} ${y + r} L${x} ${y + height - r} Q${x} ${y + height} ${x + r} ${y + height} L${x + width} ${y + height} Z`;
  }
  // "right": horizontal bars growing from a left baseline.
  return `M${x} ${y} L${x + width - r} ${y} Q${x + width} ${y} ${x + width} ${y + r} L${x + width} ${y + height - r} Q${x + width} ${y + height} ${x + width - r} ${y + height} L${x} ${y + height} Z`;
}

/* ===========================
   SCALES AND FORMATTING
=========================== */

// Axis ticks land on numbers a person would choose: 0 / 25 / 50, never
// 0 / 23.7 / 47.4. Returns the rounded-up maximum and the ticks under it.
export function niceScale(maxValue, tickCount = 4) {
  const max = Math.max(maxValue, 0);
  if (max === 0) return { max: 1, ticks: [0, 1] };

  const rough = max / tickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) *
    magnitude;

  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return { max: top, ticks };
}

// Axis and tile figures: 1,284 / 12.9K / 4.2M. Big numbers on an axis are read
// for their size, and six digits under a column is noise.
export function compact(value) {
  const number = Number(value) || 0;
  const sign = number < 0 ? "-" : "";
  const size = Math.abs(number);
  if (size >= 1e6) return `${sign}${trimZero(size / 1e6)}M`;
  if (size >= 1e4) return `${sign}${trimZero(size / 1e3)}K`;
  return sign + Math.round(size).toLocaleString("en-US");
}

function trimZero(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// Arial has no metrics API worth calling per label, so widths are estimated.
// Only ever used to decide whether a label fits — an estimate that is a little
// generous drops a label rather than clipping one, which is the safe direction.
function textWidth(value, fontSize) {
  return String(value).length * fontSize * 0.58;
}

function truncate(value, maxChars) {
  const string = String(value ?? "");
  return string.length > maxChars ? `${string.slice(0, maxChars - 1)}…` : string;
}

/* ===========================
   TOOLTIP
=========================== */

// One tooltip for the whole page, created on first use. Positioned in viewport
// coordinates so it is never clipped by a card's own overflow.
let tipEl = null;

function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "viz-tip";
    tipEl.setAttribute("role", "status");
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

// rows: [{ label, value, color }]. The swatch carries the series identity; the
// text stays in ink, same rule as the charts themselves.
function showTip(event, title, rows) {
  const tip = tooltip();
  tip.innerHTML = "";

  const heading = document.createElement("p");
  heading.className = "viz-tip-title";
  heading.textContent = title;
  tip.appendChild(heading);

  for (const row of rows) {
    const line = document.createElement("p");
    line.className = "viz-tip-row";

    if (row.color) {
      const swatch = document.createElement("span");
      swatch.className = "viz-tip-swatch";
      swatch.style.background = row.color;
      line.appendChild(swatch);
    }

    const label = document.createElement("span");
    label.className = "viz-tip-label";
    label.textContent = row.label;

    const value = document.createElement("span");
    value.className = "viz-tip-value";
    value.textContent = row.value;

    line.append(label, value);
    tip.appendChild(line);
  }

  tip.hidden = false;
  positionTip(event);
}

function positionTip(event) {
  const tip = tooltip();
  if (tip.hidden) return;

  const box = tip.getBoundingClientRect();
  const margin = 14;
  let left = event.clientX + margin;
  let top = event.clientY + margin;

  // Flip rather than slide when it would run off: a tooltip pinned to the edge
  // covers the mark the pointer is on.
  if (left + box.width > window.innerWidth - 8) left = event.clientX - box.width - margin;
  if (top + box.height > window.innerHeight - 8) top = event.clientY - box.height - margin;

  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

/* ===========================
   RE-RENDERING ON RESIZE
=========================== */

// Charts are drawn at the width they actually have — no viewBox stretching,
// which would scale the type along with the geometry and leave the axis labels
// a different size on every card. So each chart remembers how to redraw itself
// and does so when its box changes.
const specs = new WeakMap();

const observer =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          const entry_spec = specs.get(entry.target);
          if (!entry_spec) continue;
          const width = entry.target.clientWidth;
          // Ignore the pixel-level jitter a scrollbar appearing causes.
          if (Math.abs(width - entry_spec.lastWidth) < 8) continue;
          entry_spec.lastWidth = width;
          entry_spec.draw(entry.target, entry_spec.spec, width);
        }
      });

function mount(container, spec, draw) {
  const width = container.clientWidth || 640;
  specs.set(container, { spec, draw, lastWidth: width });
  if (observer) observer.observe(container);
  draw(container, spec, width);
}

// Wraps the SVG in a figure that carries the accessible description. The SVG
// itself is one image as far as a screen reader is concerned — the numbers
// behind it are reachable through the table twin, which is the readable copy.
function frame(container, width, height, ariaLabel) {
  container.innerHTML = "";
  const svg = el("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": ariaLabel || "",
    class: "viz-svg",
  });
  container.appendChild(svg);
  return svg;
}

/* ===========================
   LINE CHART
=========================== */

/**
 * A trend over time, one line per series.
 *
 * @param {HTMLElement} container
 * @param {object} spec
 * @param {string[]} spec.labels      One per point, used in the tooltip.
 * @param {string[]} spec.tickLabels  Short versions for the x axis.
 * @param {Array<{key,label,color,values:number[],area?:boolean}>} spec.series
 * @param {(v:number)=>string} [spec.format]  Tooltip and end-label formatter.
 * @param {(v:number)=>string} [spec.axisFormat]
 * @param {number} [spec.height]
 */
export function lineChart(container, spec) {
  mount(container, spec, drawLine);
}

function drawLine(container, spec, width) {
  const height = spec.height || 280;
  const format = spec.format || compact;
  const axisFormat = spec.axisFormat || compact;
  const svg = frame(container, width, height, spec.ariaLabel);

  const points = spec.labels.length;
  const maxValue = Math.max(
    0,
    ...spec.series.flatMap((series) => series.values.map((value) => Number(value) || 0))
  );
  const scale = niceScale(maxValue);

  // The end labels live in the right-hand margin, so the margin is sized from
  // the widest of them rather than guessed at.
  const endLabelWidth = spec.series.length
    ? Math.max(
        ...spec.series.map((series) =>
          textWidth(format(series.values[points - 1] || 0), 12)
        )
      ) + 12
    : 0;

  const padding = {
    top: 16,
    right: Math.min(Math.max(endLabelWidth, 16), 96),
    bottom: 30,
    left: Math.max(46, textWidth(axisFormat(scale.max), 12) + 14),
  };
  const plotWidth = Math.max(10, width - padding.left - padding.right);
  const plotHeight = Math.max(10, height - padding.top - padding.bottom);

  const xAt = (index) =>
    padding.left + (points <= 1 ? plotWidth / 2 : (index / (points - 1)) * plotWidth);
  const yAt = (value) =>
    padding.top + plotHeight - ((Number(value) || 0) / scale.max) * plotHeight;

  // Gridlines and their ticks, drawn first so every mark sits on top of them.
  for (const tick of scale.ticks) {
    const y = yAt(tick);
    svg.appendChild(
      el("line", {
        x1: padding.left,
        x2: padding.left + plotWidth,
        y1: y,
        y2: y,
        stroke: tick === 0 ? INK.axis : INK.grid,
        "stroke-width": 1,
      })
    );
    svg.appendChild(
      text(axisFormat(tick), {
        x: padding.left - 8,
        y: y + 4,
        "text-anchor": "end",
        fill: INK.faint,
      })
    );
  }

  // As many x labels as fit without touching, always including the last day:
  // the end of the window is the one date a reader looks for.
  const maxLabels = Math.max(2, Math.floor(plotWidth / 62));
  const step = Math.max(1, Math.ceil(points / maxLabels));
  for (let index = 0; index < points; index++) {
    if (index % step !== 0 && index !== points - 1) continue;
    // Skip a label that would sit on top of the last one.
    if (index !== points - 1 && (points - 1 - index) < step * 0.6) continue;
    svg.appendChild(
      text(spec.tickLabels[index], {
        x: xAt(index),
        y: height - 10,
        "text-anchor": "middle",
        fill: INK.faint,
      })
    );
  }

  // A single series gets a wash under it; several do not, because overlapping
  // washes read as a colour nobody chose.
  const wash = spec.series.length === 1;

  for (const series of spec.series) {
    const path = series.values
      .map((value, index) => `${index === 0 ? "M" : "L"}${xAt(index)} ${yAt(value)}`)
      .join(" ");

    if (wash && points > 1) {
      svg.appendChild(
        el("path", {
          d: `${path} L${xAt(points - 1)} ${yAt(0)} L${xAt(0)} ${yAt(0)} Z`,
          fill: series.color,
          opacity: 0.1,
        })
      );
    }

    svg.appendChild(
      el("path", {
        d: path,
        fill: "none",
        stroke: series.color,
        "stroke-width": 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      })
    );

    // A one-day window has no line to draw, so the point itself has to be
    // visible or the chart is empty.
    if (points === 1) {
      svg.appendChild(
        el("circle", {
          cx: xAt(0),
          cy: yAt(series.values[0]),
          r: 4,
          fill: series.color,
          stroke: INK.surface,
          "stroke-width": 2,
        })
      );
    }
  }

  // End dots and the one direct label per series. Labels that would collide are
  // dropped rather than nudged apart: a label pushed off its own line stops
  // meaning anything, and the tooltip and the table still carry the value.
  const placed = [];
  for (const series of spec.series) {
    const value = series.values[points - 1];
    const y = yAt(value);

    svg.appendChild(
      el("circle", {
        cx: xAt(points - 1),
        cy: y,
        r: 4,
        fill: series.color,
        stroke: INK.surface,
        "stroke-width": 2,
      })
    );

    const collides = placed.some((other) => Math.abs(other - y) < 14);
    if (!collides && padding.right >= 30) {
      placed.push(y);
      svg.appendChild(
        text(format(value), {
          x: xAt(points - 1) + 9,
          y: y + 4,
          fill: INK.secondary,
          "font-weight": 700,
        })
      );
    }
  }

  attachCrosshair(svg, {
    spec,
    format,
    points,
    xAt,
    yAt,
    padding,
    plotWidth,
    plotHeight,
    container,
  });
}

// The hover layer: a vertical rule at the nearest point, a dot on every series
// there, and one tooltip listing all of them. Keyboard users get the same thing
// with the arrow keys — the chart is focusable, and focus follows the same
// index the pointer would.
function attachCrosshair(svg, ctx) {
  const { spec, format, points, xAt, yAt, padding, plotWidth, plotHeight } = ctx;

  const layer = el("g", { class: "viz-crosshair", opacity: 0 });
  const rule = el("line", {
    y1: padding.top,
    y2: padding.top + plotHeight,
    stroke: INK.axis,
    "stroke-width": 1,
  });
  layer.appendChild(rule);

  const dots = spec.series.map((series) =>
    el("circle", { r: 4.5, fill: series.color, stroke: INK.surface, "stroke-width": 2 })
  );
  dots.forEach((dot) => layer.appendChild(dot));
  svg.appendChild(layer);

  const capture = el("rect", {
    x: padding.left,
    y: padding.top,
    width: plotWidth,
    height: plotHeight,
    fill: "transparent",
    tabindex: 0,
    class: "viz-capture",
  });
  svg.appendChild(capture);

  let index = -1;

  function moveTo(next, event) {
    index = Math.max(0, Math.min(points - 1, next));
    const x = xAt(index);
    rule.setAttribute("x1", x);
    rule.setAttribute("x2", x);
    dots.forEach((dot, seriesIndex) => {
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", yAt(spec.series[seriesIndex].values[index]));
    });
    layer.setAttribute("opacity", 1);

    showTip(
      event || pointFor(x, ctx),
      spec.labels[index],
      spec.series.map((series) => ({
        label: series.label,
        value: format(series.values[index]),
        color: series.color,
      }))
    );
  }

  function leave() {
    layer.setAttribute("opacity", 0);
    hideTip();
  }

  capture.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const ratio = (event.clientX - box.left - padding.left) / plotWidth;
    moveTo(Math.round(ratio * (points - 1)), event);
  });
  capture.addEventListener("pointerleave", leave);
  capture.addEventListener("blur", leave);
  capture.addEventListener("focus", (event) => moveTo(index < 0 ? points - 1 : index, pointFor(xAt(points - 1), ctx)));
  capture.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = index + (event.key === "ArrowRight" ? 1 : -1);
    moveTo(next, pointFor(xAt(Math.max(0, Math.min(points - 1, next))), ctx));
  });
}

// A synthetic pointer position for the keyboard path, so the tooltip lands on
// the point being read rather than wherever the mouse happens to be.
function pointFor(x, ctx) {
  const box = ctx.container.getBoundingClientRect();
  return { clientX: box.left + x, clientY: box.top + ctx.padding.top + 10 };
}

/* ===========================
   COLUMN CHART  (histograms)
=========================== */

/**
 * Vertical columns: counts across ordered buckets — hours of the day, weekdays,
 * how long the trips took.
 *
 * @param {HTMLElement} container
 * @param {object} spec
 * @param {Array<{label,value,note?}>} spec.bars
 * @param {string} [spec.color]
 * @param {string} [spec.valueLabel]  What one column counts, for the tooltip.
 */
export function columnChart(container, spec) {
  mount(container, spec, drawColumns);
}

function drawColumns(container, spec, width) {
  const height = spec.height || 240;
  const format = spec.format || compact;
  const axisFormat = spec.axisFormat || compact;
  const color = spec.color || SERIES_COLORS[0];
  const svg = frame(container, width, height, spec.ariaLabel);

  const bars = spec.bars;
  const scale = niceScale(Math.max(0, ...bars.map((bar) => bar.value)));
  const padding = {
    top: 14,
    right: 10,
    bottom: 28,
    left: Math.max(40, textWidth(axisFormat(scale.max), 12) + 14),
  };
  const plotWidth = Math.max(10, width - padding.left - padding.right);
  const plotHeight = Math.max(10, height - padding.top - padding.bottom);

  const band = plotWidth / bars.length;
  // Capped rather than filling the slot: the leftover is the air between
  // columns, and a 2px minimum gap keeps neighbours from touching.
  const barWidth = Math.max(3, Math.min(24, band - Math.max(2, band * 0.34)));

  for (const tick of scale.ticks) {
    const y = padding.top + plotHeight - (tick / scale.max) * plotHeight;
    svg.appendChild(
      el("line", {
        x1: padding.left,
        x2: padding.left + plotWidth,
        y1: y,
        y2: y,
        stroke: tick === 0 ? INK.axis : INK.grid,
        "stroke-width": 1,
      })
    );
    svg.appendChild(
      text(axisFormat(tick), { x: padding.left - 8, y: y + 4, "text-anchor": "end", fill: INK.faint })
    );
  }

  // Thin the x labels when they would collide — 24 hours on a narrow card is
  // the case this exists for.
  const labelStep = Math.max(1, Math.ceil((bars.length * 34) / plotWidth));

  bars.forEach((bar, index) => {
    const value = Number(bar.value) || 0;
    const x = padding.left + index * band + (band - barWidth) / 2;
    const barHeight = (value / scale.max) * plotHeight;
    const y = padding.top + plotHeight - barHeight;

    if (value > 0) {
      svg.appendChild(
        el("path", {
          d: barPath(x, y, barWidth, barHeight, 4, "top"),
          fill: bar.color || color,
        })
      );
    }

    if (index % labelStep === 0) {
      svg.appendChild(
        text(bar.label, {
          x: padding.left + index * band + band / 2,
          y: height - 9,
          "text-anchor": "middle",
          fill: INK.faint,
        })
      );
    }

    // The hit area is the whole band, not the column: a 3px bar on a busy hour
    // chart is not something anyone should have to land on.
    const hit = el("rect", {
      x: padding.left + index * band,
      y: padding.top,
      width: band,
      height: plotHeight,
      fill: "transparent",
      class: "viz-capture",
    });
    const rows = [{ label: spec.valueLabel || "Value", value: format(value), color: bar.color || color }];
    if (bar.note) rows.push({ label: bar.note.label, value: bar.note.value });

    hit.addEventListener("pointerenter", (event) => showTip(event, bar.tooltipLabel || bar.label, rows));
    hit.addEventListener("pointermove", positionTip);
    hit.addEventListener("pointerleave", hideTip);
    svg.appendChild(hit);
  });
}

/* ===========================
   HORIZONTAL BAR CHART
=========================== */

/**
 * Ranked magnitudes with names down the left — areas, cities, drivers. One hue
 * for every bar: the categories have no order of their own, so colouring them
 * by size would encode the bar's length twice and say nothing new.
 *
 * @param {HTMLElement} container
 * @param {object} spec
 * @param {Array<{label,value,note?,color?}>} spec.rows
 */
export function barChart(container, spec) {
  mount(container, spec, drawBars);
}

function drawBars(container, spec, width) {
  const format = spec.format || compact;
  const rows = spec.rows;
  const rowHeight = spec.rowHeight || 30;
  const height = rows.length * rowHeight + 12;
  const svg = frame(container, width, Math.max(height, 40), spec.ariaLabel);

  // The name column takes a share of the width rather than a fixed number of
  // pixels, so a narrow card gives the bars room instead of the labels.
  const labelWidth = Math.min(Math.max(84, width * 0.28), 190);
  const maxChars = Math.floor(labelWidth / 7);
  const max = Math.max(1, ...rows.map((row) => Number(row.value) || 0));
  const valueWidth = Math.max(
    ...rows.map((row) => textWidth(format(row.value), 12))
  ) + 12;
  const trackWidth = Math.max(20, width - labelWidth - valueWidth - 8);

  rows.forEach((row, index) => {
    const value = Number(row.value) || 0;
    // 2px of the row height is the gap between neighbours; the bar is capped so
    // a short list does not turn into slabs.
    const barHeight = Math.min(24, rowHeight - 12);
    const y = index * rowHeight + (rowHeight - barHeight) / 2;
    const barWidth = (value / max) * trackWidth;

    svg.appendChild(
      text(truncate(row.label, maxChars), {
        x: 0,
        y: y + barHeight / 2 + 4,
        fill: INK.secondary,
      })
    );

    if (barWidth > 0) {
      svg.appendChild(
        el("path", {
          d: barPath(labelWidth, y, Math.max(barWidth, 2), barHeight, 4, "right"),
          fill: row.color || spec.color || SERIES_COLORS[0],
        })
      );
    }

    // At the tip, always outside the bar: a value set inside a short bar is the
    // clipped-label case, and there is room out here for all of them.
    svg.appendChild(
      text(format(value), {
        x: labelWidth + Math.max(barWidth, 2) + 8,
        y: y + barHeight / 2 + 4,
        fill: INK.primary,
        "font-weight": 700,
      })
    );

    const hit = el("rect", {
      x: 0,
      y: index * rowHeight,
      width,
      height: rowHeight,
      fill: "transparent",
      class: "viz-capture",
    });
    const tipRows = [
      { label: spec.valueLabel || "Value", value: format(value), color: row.color || spec.color || SERIES_COLORS[0] },
      ...(row.notes || []),
    ];
    hit.addEventListener("pointerenter", (event) => showTip(event, row.label, tipRows));
    hit.addEventListener("pointermove", positionTip);
    hit.addEventListener("pointerleave", hideTip);
    svg.appendChild(hit);
  });
}

/* ===========================
   STACKED BAR  (part to whole)
=========================== */

/**
 * One bar, split into its parts — the outcome mix, the payment split. Preferred
 * over a pie: segments on a common baseline can be compared by eye, slices of a
 * circle cannot.
 *
 * @param {HTMLElement} container
 * @param {object} spec
 * @param {Array<{label,value,color}>} spec.segments
 */
export function stackedBar(container, spec) {
  mount(container, spec, drawStacked);
}

function drawStacked(container, spec, width) {
  const format = spec.format || compact;
  const height = spec.height || 46;
  const svg = frame(container, width, height, spec.ariaLabel);

  const segments = spec.segments.filter((segment) => (Number(segment.value) || 0) > 0);
  const total = segments.reduce((sum, segment) => sum + Number(segment.value), 0);
  if (!total) {
    svg.appendChild(text("No data for this period", { x: 0, y: 24, fill: INK.faint }));
    return;
  }

  const barHeight = Math.min(24, height - 8);
  const gap = 2; // in the surface colour, not a stroke
  const usable = width - gap * (segments.length - 1);
  let x = 0;

  segments.forEach((segment, index) => {
    const share = Number(segment.value) / total;
    const segmentWidth = Math.max(2, share * usable);
    const first = index === 0;
    const last = index === segments.length - 1;

    // Rounded only at the two ends of the whole bar; the interior joins stay
    // square so the 2px gaps read as cuts rather than as separate pills.
    const top = (height - barHeight) / 2;
    let node;
    if (first && last) {
      node = el("rect", { x, y: top, width: segmentWidth, height: barHeight, rx: 4 });
    } else {
      const path = first
        ? barPath(x, top, segmentWidth, barHeight, 4, "left")
        : last
        ? barPath(x, top, segmentWidth, barHeight, 4, "right")
        : `M${x} ${top} h${segmentWidth} v${barHeight} h${-segmentWidth} Z`;
      node = el("path", { d: path });
    }
    node.setAttribute("fill", segment.color);
    svg.appendChild(node);

    // The percentage goes inside only when it genuinely fits; otherwise it is
    // carried by the legend and the tooltip rather than being cropped.
    const percent = `${Math.round(share * 100)}%`;
    if (segmentWidth > textWidth(percent, 12) + 16) {
      svg.appendChild(
        text(percent, {
          x: x + segmentWidth / 2,
          y: height / 2 + 4,
          "text-anchor": "middle",
          fill: "#ffffff",
          "font-weight": 700,
        })
      );
    }

    const hit = el("rect", {
      x,
      y: 0,
      width: segmentWidth + gap,
      height,
      fill: "transparent",
      class: "viz-capture",
    });
    hit.addEventListener("pointerenter", (event) =>
      showTip(event, segment.label, [
        { label: spec.valueLabel || "Orders", value: format(segment.value), color: segment.color },
        { label: "Share", value: percent },
      ])
    );
    hit.addEventListener("pointermove", positionTip);
    hit.addEventListener("pointerleave", hideTip);
    svg.appendChild(hit);

    x += segmentWidth + gap;
  });
}

/* ===========================
   SPARKLINE
=========================== */

// The 30-day shape behind a KPI tile. Deliberately unlabelled and axis-less —
// it says "rising" or "flat", and the number beside it says how much.
export function sparkline(values, options = {}) {
  const width = options.width || 108;
  const height = options.height || 30;
  const color = options.color || INK.quiet;
  const accent = options.accent || SERIES_COLORS[0];

  const svg = el("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    class: "viz-spark",
    "aria-hidden": "true",
  });

  const numbers = values.map((value) => Number(value) || 0);
  if (numbers.length < 2) return svg;

  const max = Math.max(...numbers);
  const min = Math.min(...numbers);
  const span = max - min || 1;
  const xAt = (index) => (index / (numbers.length - 1)) * (width - 4) + 2;
  const yAt = (value) => height - 3 - ((value - min) / span) * (height - 6);

  svg.appendChild(
    el("path", {
      d: numbers.map((value, index) => `${index ? "L" : "M"}${xAt(index)} ${yAt(value)}`).join(" "),
      fill: "none",
      stroke: color,
      "stroke-width": 2,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    })
  );

  svg.appendChild(
    el("circle", {
      cx: xAt(numbers.length - 1),
      cy: yAt(numbers[numbers.length - 1]),
      r: 3,
      fill: accent,
      stroke: INK.surface,
      "stroke-width": 2,
    })
  );

  return svg;
}

/* ===========================
   LEGEND AND TABLE TWIN
=========================== */

/**
 * The dependable identity channel. Present whenever a chart carries two or more
 * series or segments — a reader must never have to match colours from memory.
 *
 * @param {Array<{label,color,value?}>} items
 */
export function legend(items) {
  const list = document.createElement("ul");
  list.className = "viz-legend";

  for (const item of items) {
    const entry = document.createElement("li");

    const swatch = document.createElement("span");
    swatch.className = "viz-legend-swatch";
    swatch.style.background = item.color;

    const label = document.createElement("span");
    label.className = "viz-legend-label";
    label.textContent = item.label;

    entry.append(swatch, label);

    if (item.value !== undefined) {
      const value = document.createElement("span");
      value.className = "viz-legend-value";
      value.textContent = item.value;
      entry.appendChild(value);
    }

    list.appendChild(entry);
  }

  return list;
}

/**
 * The readable copy of a chart: the same numbers as a table, for a screen
 * reader, for anyone who cannot separate the colours, and for the dispatcher
 * who wants the figure rather than the picture. Every chart on the page has one.
 *
 * @param {string[]} columns
 * @param {Array<Array<string|number>>} rows
 */
export function dataTable(columns, rows) {
  const table = document.createElement("table");
  table.className = "viz-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.textContent = column;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);

  const body = document.createElement("tbody");
  for (const row of rows) {
    const line = document.createElement("tr");
    row.forEach((value, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.setAttribute("scope", "row");
      cell.textContent = String(value ?? "");
      line.appendChild(cell);
    });
    body.appendChild(line);
  }

  table.append(head, body);
  return table;
}

// Hovering a chart that is being scrolled past leaves a tooltip stranded, and a
// tooltip left on screen over the next card is worse than no tooltip at all.
window.addEventListener("scroll", hideTip, { passive: true });
window.addEventListener("blur", hideTip);
