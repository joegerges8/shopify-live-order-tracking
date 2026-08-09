-- stores table
-- One row per Shopify store that installs Live Dispatch.
-- Drivers are intentionally NOT scoped to a store; they are shared globally.
-- Shopify offline access tokens expire after 60 minutes and are renewed with
-- refresh_token, which is itself valid for 90 days. Both expiries are stored
-- as absolute timestamps so the backend knows when to rotate them.
CREATE TABLE stores (
    id SERIAL PRIMARY KEY,
    shop_domain VARCHAR(255) UNIQUE NOT NULL,
    access_token TEXT NOT NULL DEFAULT '',
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope TEXT,
    setup_token TEXT,
    store_name VARCHAR(255),
    admin_password_hash TEXT,
    active BOOLEAN DEFAULT TRUE,
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- drivers table
-- Stores one row per delivery driver. password_hash holds the bcrypt hash
-- of the driver's password — the plain text is never stored.
-- status indicates whether the driver is currently available for assignments.
-- Drivers are shared across all stores.
CREATE TABLE drivers (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE,
    phone VARCHAR(30) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    status VARCHAR(30) DEFAULT 'AVAILABLE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Migration for existing databases: ALTER TABLE drivers ADD COLUMN email VARCHAR(150) UNIQUE;

-- orders table
-- Created automatically when a Shopify webhook fires (new order placed).
-- The dispatcher assigns a driver by setting assigned_driver_id.
-- order_status tracks the delivery lifecycle:
--   UNFULFILLED → ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED
--   (or RETURNED when the driver brings the order back, or CANCELLED at any point)
-- delivered_at is stamped by the backend the moment status becomes DELIVERED,
-- providing an accurate record of when each delivery was completed.
-- This column was added after the initial schema via the migration below.
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    store_id INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    shopify_order_id BIGINT UNIQUE NOT NULL,  -- links back to the Shopify order
    order_number VARCHAR(50),
    customer_first_name VARCHAR(100),
    customer_last_name VARCHAR(100),
    customer_phone VARCHAR(30),
    customer_email VARCHAR(150),
    shipping_address TEXT,
    city VARCHAR(100),
    area VARCHAR(50),                         -- delivery area (caza) derived from city
                                              -- by src/utils/areaLookup.js at write time;
                                              -- 'Other' when the city cannot be resolved.
                                              -- A dispatcher can override it per order.
    country VARCHAR(100),
    total_price NUMERIC(10,2),
    financial_status VARCHAR(50),
    prepaid BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE when the order already arrived
                                              -- paid from Shopify (customer paid online).
                                              -- Written once, when the order is first
                                              -- imported or received by webhook, and never
                                              -- touched again — financial_status flips to
                                              -- 'paid' on delivery for COD orders too, so
                                              -- it cannot tell the two cases apart later.
                                              -- The driver app uses it to exclude prepaid
                                              -- orders from earnings: no cash is collected
                                              -- for them, so counting them would report the
                                              -- same money twice.
    fulfillment_status VARCHAR(50),
    line_items JSONB NOT NULL DEFAULT '[]'::JSONB,  -- what is actually in the bag:
                                              -- [{ title, variant_title, quantity }, …]
                                              -- copied from the Shopify order at import /
                                              -- webhook time so the driver app can list the
                                              -- products without calling Shopify. Empty array
                                              -- for orders written before this column existed.
    note TEXT,                                -- the Shopify order note, copied over at
                                              -- import / webhook time and shown to the
                                              -- driver on the order detail screen. This
                                              -- is the same field the merchant edits in
                                              -- the Shopify admin ("Notes" on the order),
                                              -- so instructions written there — "ring the
                                              -- upstairs bell", "call before arriving" —
                                              -- reach the driver without a second tool.
                                              -- NULL when the order carries no note.
    driver_note TEXT,                         -- what the driver wrote about this order
                                              -- from the app ("nobody home, tried 3pm",
                                              -- "gate code 4412"). Unlike note above it
                                              -- never syncs to Shopify: the driver owns
                                              -- it, and only the driver assigned to the
                                              -- order can write it. NULL until they do.
    order_status VARCHAR(30) DEFAULT 'UNFULFILLED',
    assigned_driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
    tracking_token TEXT,                      -- shared with customer for live tracking
    customer_latitude NUMERIC(10,7),
    customer_longitude NUMERIC(10,7),
    customer_altitude NUMERIC(10,2),
    google_maps_link TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,                   -- set automatically when status = 'DELIVERED'
    fulfilled_at TIMESTAMP                    -- set when status = 'FULFILLED'; completed orders
                                              -- drop off the dashboard once this is older than
                                              -- DASHBOARD_ORDER_RETENTION_DAYS (default 7)
);
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN area VARCHAR(50);
-- Then backfill existing rows from their city: node scripts/backfill-areas.js
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN fulfilled_at TIMESTAMP;
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN delivered_at TIMESTAMP;
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN line_items JSONB NOT NULL DEFAULT '[]'::JSONB;
-- Existing rows stay empty until the order is re-imported from Shopify
-- (the dashboard's "import orders" action backfills them).
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN driver_note TEXT;
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN note TEXT;
-- Existing rows stay NULL until the order is updated in Shopify (the orders/updated
-- webhook carries the note) or re-imported from the dashboard.
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN prepaid BOOLEAN NOT NULL DEFAULT FALSE;
-- Then backfill the rows that were still undelivered at migration time — for those,
-- financial_status = 'paid' can only mean the customer paid online:
--   UPDATE orders SET prepaid = TRUE WHERE financial_status = 'paid' AND delivered_at IS NULL;
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN store_id INT REFERENCES stores(id) ON DELETE CASCADE;
-- After backfilling existing rows, run: ALTER TABLE orders ALTER COLUMN store_id SET NOT NULL;

-- location_updates table
-- Each row is one GPS ping from the driver's device during an active delivery.
-- The customer's live-tracking page queries these rows to show the driver's
-- position moving in real time. ON DELETE CASCADE ensures that if an order
-- is deleted, its location history is cleaned up automatically.
CREATE TABLE location_updates (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    latitude NUMERIC(10,7) NOT NULL,
    longitude NUMERIC(10,7) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
