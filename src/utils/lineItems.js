// lineItems.js
//
// Turns a Shopify order's `line_items` array into the compact shape stored in
// orders.line_items (JSONB) and handed to the driver app.
//
// Shopify's own line item objects carry dozens of fields (tax lines, discount
// allocations, fulfillment service, duties…). The driver only needs to know
// what is in the bag, so we keep the product name, the variant when it says
// something ("500ml", "Large") and the quantity.

function blankToNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

// Shopify uses the literal string "Default Title" for products without real
// variants — showing it next to the name would be noise.
function meaningfulVariantTitle(value) {
  const title = blankToNull(value);
  if (!title) return null;
  return title.toLowerCase() === "default title" ? null : title;
}

// How many of the item are still on the order.
//
// Editing an order in Shopify — the customer ringing up to drop a product —
// does not take the line off the payload: `quantity` keeps the number
// originally bought and `current_quantity` reports what is left, which is 0
// for a line that was removed entirely. Reading `quantity` alone is what used
// to leave a cancelled product in the driver's bag list.
//
// Returns 0 for a removed line, which extractLineItems then drops. A payload
// carrying no usable number at all falls back to 1 rather than 0, so a line
// item is never silently dropped for want of a quantity.
function resolveQuantity(item) {
  const current = Number(item.current_quantity);
  if (Number.isFinite(current)) return Math.max(0, Math.round(current));

  const original = Number(item.quantity);
  if (!Number.isFinite(original)) return 1;
  return Math.max(0, Math.round(original));
}

// Returns [] rather than null when an order has no usable line items, so the
// column always holds a JSON array and consumers never have to null-check.
function extractLineItems(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];

  return items
    .map((item) => {
      const title = blankToNull(item.title) || blankToNull(item.name);
      if (!title) return null;

      const quantity = resolveQuantity(item);
      // Removed from the order in a Shopify edit — not in the bag any more.
      if (quantity <= 0) return null;

      return {
        title,
        variant_title: meaningfulVariantTitle(item.variant_title),
        quantity,
      };
    })
    .filter(Boolean);
}

module.exports = { extractLineItems };
