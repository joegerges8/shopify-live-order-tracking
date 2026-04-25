-- drivers table
-- Stores one row per delivery driver. password_hash holds the bcrypt hash
-- of the driver's password — the plain text is never stored.
-- status indicates whether the driver is currently available for assignments.
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
--   PENDING → ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED
--   (or CANCELLED at any point)
-- delivered_at is stamped by the backend the moment status becomes DELIVERED,
-- providing an accurate record of when each delivery was completed.
-- This column was added after the initial schema via the migration below.
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    shopify_order_id BIGINT UNIQUE NOT NULL,  -- links back to the Shopify order
    order_number VARCHAR(50),
    customer_first_name VARCHAR(100),
    customer_last_name VARCHAR(100),
    customer_phone VARCHAR(30),
    customer_email VARCHAR(150),
    shipping_address TEXT,
    city VARCHAR(100),
    country VARCHAR(100),
    total_price NUMERIC(10,2),
    financial_status VARCHAR(50),
    fulfillment_status VARCHAR(50),
    order_status VARCHAR(30) DEFAULT 'PENDING',
    assigned_driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
    tracking_token TEXT,                      -- shared with customer for live tracking
    customer_latitude NUMERIC(10,7),
    customer_longitude NUMERIC(10,7),
    customer_altitude NUMERIC(10,2),
    google_maps_link TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP                    -- set automatically when status = 'DELIVERED'
);
-- Migration for existing databases: ALTER TABLE orders ADD COLUMN delivered_at TIMESTAMP;

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