// What happens to a dashboard order when the customer rings up and has an item
// taken off it. The merchant edits the order in Shopify, orders/updated fires,
// and these two helpers are what read the new shape of it out of the payload.

const test = require("node:test");
const assert = require("node:assert");

const { extractLineItems } = require("../src/utils/lineItems");
const { resolveOrderTotal } = require("../src/utils/orderTotal");

test("the edited total wins over the amount the order was placed at", () => {
  assert.strictEqual(
    resolveOrderTotal({ total_price: "45.00", current_total_price: "30.00" }),
    30
  );
});

test("an unedited order still reads its total", () => {
  assert.strictEqual(resolveOrderTotal({ total_price: "45.00" }), 45);
});

test("a payload without any total leaves the stored one alone", () => {
  assert.strictEqual(resolveOrderTotal({}), null);
  assert.strictEqual(resolveOrderTotal({ total_price: "" }), null);
  assert.strictEqual(resolveOrderTotal({ total_price: "n/a" }), null);
});

test("a free order reads as 0, not as no total at all", () => {
  assert.strictEqual(resolveOrderTotal({ current_total_price: "0.00" }), 0);
});

test("a product removed from the order drops out of the driver's bag list", () => {
  const items = extractLineItems({
    line_items: [
      { title: "Labneh", quantity: 2, current_quantity: 2 },
      { title: "Olive oil", quantity: 1, current_quantity: 0 },
    ],
  });

  assert.deepStrictEqual(items, [
    { title: "Labneh", variant_title: null, quantity: 2 },
  ]);
});

test("a partly reduced line keeps what is left of it", () => {
  const items = extractLineItems({
    line_items: [{ title: "Labneh", variant_title: "500ml", quantity: 3, current_quantity: 1 }],
  });

  assert.deepStrictEqual(items, [
    { title: "Labneh", variant_title: "500ml", quantity: 1 },
  ]);
});

test("an orders/create payload, which carries no current_quantity, is unaffected", () => {
  const items = extractLineItems({
    line_items: [
      { title: "Labneh", quantity: 2 },
      { title: "Bread", quantity: undefined },
    ],
  });

  assert.deepStrictEqual(items, [
    { title: "Labneh", variant_title: null, quantity: 2 },
    { title: "Bread", variant_title: null, quantity: 1 },
  ]);
});
