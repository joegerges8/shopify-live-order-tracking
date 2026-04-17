CREATE TABLE drivers (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    status VARCHAR(30) DEFAULT 'AVAILABLE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    shopify_order_id BIGINT UNIQUE NOT NULL,
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
    tracking_token TEXT,
    customer_latitude NUMERIC(10,7),
    customer_longitude NUMERIC(10,7),
    customer_altitude NUMERIC(10,2),
    google_maps_link TEXT,
    address_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
);

CREATE TABLE location_updates (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    driver_id INT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    latitude NUMERIC(10,7) NOT NULL,
    longitude NUMERIC(10,7) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);