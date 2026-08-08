// check-area-coverage.js
//
// Runs every city string from 3 years of real order history through the area
// lookup and reports how much of the order volume gets classified.
//
// Run it after editing src/utils/areaLookup.js — it is the fastest way to see
// whether a change helped or broke something, and it prints the unmatched
// strings so you know exactly what to add next.
//
//   node scripts/check-area-coverage.js
//
// The fixture (scripts/city-history.json) is [cityString, orderCount] pairs
// pulled from Shopify with:
//   FROM sales SHOW orders GROUP BY shipping_city ORDER BY orders DESC

const path = require("path");
const { resolveArea } = require("../src/utils/areaLookup");

const history = require(path.join(__dirname, "city-history.json"));

const byArea = new Map();
const unmatched = [];

let totalOrders = 0;
let matchedOrders = 0;

for (const [city, count] of history) {
  totalOrders += count;

  const area = resolveArea(city);
  if (area) {
    matchedOrders += count;
    byArea.set(area, (byArea.get(area) || 0) + count);
  } else {
    unmatched.push([city, count]);
  }
}

const pct = (n) => ((n / totalOrders) * 100).toFixed(1);

console.log(`Distinct city strings : ${history.length}`);
console.log(`Total orders          : ${totalOrders}`);
console.log(`Classified            : ${matchedOrders} (${pct(matchedOrders)}%)`);
console.log(`Unclassified          : ${totalOrders - matchedOrders} (${pct(totalOrders - matchedOrders)}%)`);

console.log("\nOrders per area");
const ranked = [...byArea.entries()].sort((a, b) => b[1] - a[1]);
for (const [area, count] of ranked) {
  console.log(`  ${area.padEnd(18)} ${String(count).padStart(4)}  ${pct(count)}%`);
}

console.log(`\nUnmatched strings (${unmatched.length})`);
for (const [city, count] of unmatched.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${JSON.stringify(city)}`);
}
