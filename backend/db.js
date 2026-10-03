const { Pool, types } = require('pg');

// Keep DATE columns as YYYY-MM-DD strings.
types.setTypeParser(1082, (value) => value);

function createPool(overrides = {}) {
  return new Pool({
    host: overrides.host || process.env.DB_HOST || '127.0.0.1',
    port: Number(overrides.port || process.env.DB_PORT || 5432),
    user: overrides.user || process.env.DB_USER,
    password: overrides.password || process.env.DB_PASSWORD,
    database: overrides.database || process.env.DB_NAME,
    max: overrides.max || 10,
    connectionTimeoutMillis: overrides.connectionTimeoutMillis || 8000,
  });
}

async function waitForDb(pool, attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

module.exports = { createPool, waitForDb };
