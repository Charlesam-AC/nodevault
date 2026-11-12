const crypto = require('crypto');
const path = require('path');

// Hosted entry. Docker still starts backend/server.js and keeps its own env.
// This process does not invent demo passwords, a closing PIN, or a seeded bank.
// Set SEED_DEMO_DATA, DEMO_PASSWORD, DEMO_CLOSING_PIN, and MASTER_ADMIN_PASSWORD
// in the host environment when an operator chooses to load the sample.

function fill(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
}

fill('ENTRA_MODE', 'entra');
fill('BUSINESS_TIMEZONE', 'Africa/Lusaka');
fill('BUSINESS_DAY_START', '08:00');
fill('TRADING_WEEKDAYS', 'Mon,Tue,Wed,Thu,Fri,Sat');
fill('CORE_BANK_MODE', 'mock');
fill('PRINTER_MODE', 'stub');
fill('MAIL_MODE', 'stub');
fill('CLOSE_PRINT_FAILURE', 'queue');
fill('DESK_NOW', '2026-10-03T10:00:00+02:00');

require(path.join(__dirname, '..', 'backend', 'server.js'));
