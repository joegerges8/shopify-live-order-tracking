// check-route-order.js
//
// Exercises the route-ordering logic without a database and without calling
// Google, using node:test so it can be run anywhere:
//
//   node --test scripts/check-route-order.js
//
// What is pinned here is everything that decides which order a driver's stops
// come out in: how orders collapse onto the distinct points they are delivered
// to, how those points turn back into one sequence number per order, and that
// applying Google's answer neither loses an order nor duplicates one.
//
// The Google call itself is not covered — it is an HTTP request whose failures
// are all handled by falling back to the distance order, which is exercised
// below as the ordering that comes out of groupOrdersIntoStops.

const test = require("node:test");
const assert = require("node:assert");

const { DEFAULT_WAREHOUSE } = require("../src/config/warehouse");
const {
  groupOrdersIntoStops,
  sequenceFromStops,
  applyOptimizedOrder,
} = require("../src/utils/routeOrder");

const warehouse = DEFAULT_WAREHOUSE;

// Metn towns, which is where the run that prompted all this goes.
const antelias = { id: 1, city: "Antelias", area: "Metn" };
const zalka = { id: 2, city: "Zalka", area: "Metn" };
const zalqa = { id: 3, city: "Zalqa", area: "Metn" }; // same town, other spelling
const jdeideh = { id: 4, city: "Jdeideh", area: "Metn" };
const dekwaneh = { id: 5, city: "Dekwaneh", area: "Metn" };

test("collapses two spellings of one town onto a single stop", () => {
  const stops = groupOrdersIntoStops([zalka, zalqa], warehouse);

  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].orderIds, [2, 3]);
});

test("orders stops by distance from the warehouse, nearest first", () => {
  // Amchit is north of all of these, so the coast road order out of the
  // warehouse runs Antelias, Zalka, Jdeideh, Dekwaneh.
  const stops = groupOrdersIntoStops([dekwaneh, jdeideh, zalka, antelias], warehouse);

  assert.deepEqual(
    stops.flatMap((stop) => stop.orderIds),
    [antelias.id, zalka.id, jdeideh.id, dekwaneh.id]
  );
});

test("prefers an exact customer pin over the town centre", () => {
  const pinned = {
    id: 6,
    city: "Dekwaneh",
    area: "Metn",
    customer_latitude: 34.14,
    customer_longitude: 35.64,
  };

  // The pin is a few hundred metres from the warehouse, so an order that would
  // otherwise be the furthest stop becomes the first.
  const stops = groupOrdersIntoStops([pinned, antelias], warehouse);
  assert.deepEqual(stops[0].orderIds, [pinned.id]);
});

test("skips an order that resolves to no coordinates at all", () => {
  const nowhere = { id: 7, city: "??", area: null };
  const stops = groupOrdersIntoStops([nowhere, antelias], warehouse);

  assert.deepEqual(
    stops.flatMap((stop) => stop.orderIds),
    [antelias.id]
  );
});

test("falls back to the caza centre when the city names no known town", () => {
  const vague = { id: 8, city: "somewhere in the metn", area: "Metn" };
  const stops = groupOrdersIntoStops([vague], warehouse);

  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].orderIds, [vague.id]);
});

test("numbers every order from 1, orders sharing a stop staying together", () => {
  const stops = groupOrdersIntoStops([antelias, zalka, zalqa], warehouse);
  const sequences = sequenceFromStops(stops);

  assert.deepEqual(sequences, [
    { orderId: antelias.id, sequence: 1 },
    { orderId: zalka.id, sequence: 2 },
    { orderId: zalqa.id, sequence: 3 },
  ]);
});

test("applying Google's order keeps every stop exactly once", () => {
  const stops = groupOrdersIntoStops([antelias, zalka, jdeideh, dekwaneh], warehouse);
  // Google coming back with the reverse of the distance order — a real
  // possibility, since the road out of the warehouse is not a straight line.
  const reordered = applyOptimizedOrder(stops, [3, 2, 1, 0]);

  assert.equal(reordered.length, stops.length);
  assert.deepEqual(
    [...reordered].sort((a, b) => a.km - b.km),
    stops
  );
  assert.deepEqual(
    sequenceFromStops(reordered).map((s) => s.orderId),
    [dekwaneh.id, jdeideh.id, zalka.id, antelias.id]
  );
});

test("an empty run produces no stops and no sequences", () => {
  assert.deepEqual(groupOrdersIntoStops([], warehouse), []);
  assert.deepEqual(sequenceFromStops([]), []);
});
