// orderTotal.js
//
// What the order is worth *now* — the number the dashboard shows and the
// driver collects on a COD delivery.
//
// Shopify keeps `total_price` as the amount the order was placed for and
// reports the amount after edits and refunds in `current_total_price`. A
// customer who rings up to drop a product leaves the two disagreeing: the
// order is edited in the admin, `current_total_price` falls, and reading
// `total_price` alone is what used to leave the old amount on the dashboard
// and in the driver's hand.
//
// So the current amount wins whenever the payload carries one, with
// `total_price` as the fallback for the older payloads and the trimmed
// fetches that do not include it.
function resolveOrderTotal(order) {
  for (const value of [order?.current_total_price, order?.total_price]) {
    if (value === null || value === undefined) continue;
    const trimmed = String(value).trim();
    if (!trimmed.length) continue;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

module.exports = { resolveOrderTotal };
