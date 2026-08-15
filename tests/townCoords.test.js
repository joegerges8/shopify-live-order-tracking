// Where an order's pin lands when all we have is what the customer typed.
//
// Two real orders anchor these tests, because both went wrong on the same day
// and each in a different way. Order #2721 put "Beirut" in the city field and
// the real neighbourhood — Achrafieh — in the street address, and the driver
// got a pin in Bachoura. Order #2722 typed a sentence into the city field and
// resolved fine, to a Fanar coordinate that was a kilometre south of Fanar.
// The first is about which field gets believed; the second was plain bad data.

const test = require("node:test");
const assert = require("node:assert");

const {
  resolveOrderTown,
  resolveCityCentre,
  resolveDestination,
  getTownCoords,
  haversineKm,
} = require("../src/utils/townCoords");

// The two orders exactly as the webhook stored them.
const order2721 = {
  city: "Beirut",
  shipping_address:
    "Achrafieh, Bourj elghazel\nTabaris\nCheri3 libnen\nSalon jean najm",
  area: "Beirut",
};
const order2722 = {
  city: "Fanar next to bonjus company",
  shipping_address: "Fanar Lebanon, Ilc Elevators Company",
  area: "Metn",
};

test("order #2721: the address's neighbourhood beats a caza-wide city", () => {
  assert.strictEqual(resolveOrderTown(order2721), "achrafieh");

  const centre = resolveCityCentre(order2721);
  assert.strictEqual(centre.town, "achrafieh");
  // And Achrafieh is not downtown: the pin must sit east of the old Beirut
  // centroid the driver was wrongly sent to.
  assert.ok(centre.longitude > 35.515);
});

test("order #2722: a sentence in the city field still finds its town", () => {
  const centre = resolveCityCentre(order2722);
  assert.strictEqual(centre.town, "fanar");
});

test("fanar's centre is in Fanar, not down the hill by Ain Saadeh", () => {
  const fanar = getTownCoords("fanar");
  const ainSaade = getTownCoords("ain saade");

  // The old coordinate sat 1.3km south, close enough to the Ain Saadeh label
  // that drivers read the pin as the wrong town. The corrected centre must be
  // north of Dekwaneh's latitude and clearly separated from Ain Saadeh.
  assert.ok(fanar.latitude > 33.872, "fanar sits north of the Dekwaneh line");
  assert.ok(
    haversineKm(
      fanar.latitude,
      fanar.longitude,
      ainSaade.latitude,
      ainSaade.longitude
    ) > 2,
    "fanar and ain saade are distinct places on the map"
  );
});

test("a specific city is believed over the street address", () => {
  // The customer said Jounieh; a Beirut mention in the address is a street
  // name or a landmark, not where they live.
  const town = resolveOrderTown({
    city: "Jounieh",
    shipping_address: "Main road, near Beirut street 5",
  });
  assert.strictEqual(town, "jounieh");
});

test("the address cannot drag a pin to a far-away namesake", () => {
  // Beirut has a Tripoli street; the real Tripoli is ~80km north. A broad
  // city is refined only within the same urban area.
  const town = resolveOrderTown({
    city: "Beirut",
    shipping_address: "Tripoli street, building 4",
  });
  assert.strictEqual(town, "beirut");
});

test("an unresolvable city falls back to the address's town", () => {
  const town = resolveOrderTown({
    city: "asdkjhq",
    shipping_address: "Fanar Lebanon",
  });
  assert.strictEqual(town, "fanar");
});

test("nothing resolvable still falls back to the area centroid", () => {
  const centre = resolveCityCentre({
    city: "asdkjhq",
    shipping_address: "qwerty",
    area: "Metn",
  });
  assert.strictEqual(centre.precision, "AREA");
});

test("an exact customer pin still beats everything", () => {
  const destination = resolveDestination({
    ...order2721,
    customer_latitude: 33.9,
    customer_longitude: 35.55,
  });
  assert.strictEqual(destination.precision, "EXACT");
  assert.strictEqual(destination.latitude, 33.9);
});

test("a city naming its town exactly is untouched by the refinement", () => {
  // The overwhelmingly common case: clean city, whatever in the address.
  const town = resolveOrderTown({
    city: "Jounieh",
    shipping_address: "Fanar Lebanon",
  });
  assert.strictEqual(town, "jounieh");
});
