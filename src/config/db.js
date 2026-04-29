//Imports PostgreSQL connection pooling from the pg package.
//instead of opening a brand new database connection for every query, Node keeps a reusable set of connections.
const { Pool } = require("pg"); 

//Loads the variables from your .env file into process.env.
require("dotenv").config({ quiet: true }); 

//Creates the PostgreSQL connection using your database settings.
//In production on Railway we prefer a single DATABASE_URL (with SSL),
//locally we fall back to individual DB_* variables from .env.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false,
      },
    })
  : new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

module.exports = pool;
