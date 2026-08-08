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

function toPositiveInt(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : fallback;
}

// Returns [] rather than null when an order has no usable line items, so the
// column always holds a JSON array and consumers never have to null-check.
function extractLineItems(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];

  return items
    .map((item) => {
      const title = blankToNull(item.title) || blankToNull(item.name);
      if (!title) return null;

      return {
        title,
        variant_title: meaningfulVariantTitle(item.variant_title),
        quantity: toPositiveInt(item.quantity),
      };
    })
    .filter(Boolean);
}

module.exports = { extractLineItems };
