const crypto = require('crypto');
const path = require('path');

// Hosted demo entry. Docker still starts backend/server.js and keeps its own env.
// These defaults are the documented sample, not a live bank.

function fill(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
}

fill('SEED_DEMO_DATA', 'true');
fill('ENABLE_LOCAL_LOGIN', 'true');
fill('AUTH_MODE', 'both');
fill('ENTRA_MODE', 'mock');
fill('MOCK_ENTRA_ASSERTION', 'change-me-entra-assertion');
fill('DEMO_PASSWORD', 'Vault-demo-2026');
fill('DEMO_CLOSING_PIN', '135790');
fill('MASTER_ADMIN_PASSWORD', 'NodeVault-admin-2026');
fill('MASTER_ADMIN_EMAIL', 'admin@demo-bank.example');
fill('ENFORCED_CORPORATE_DOMAIN', 'demo-bank.example');
fill('BUSINESS_TIMEZONE', 'Africa/Lusaka');
fill('BUSINESS_DAY_START', '08:00');
fill('TRADING_WEEKDAYS', 'Mon,Tue,Wed,Thu,Fri,Sat');
fill('CORE_BANK_MODE', 'mock');
fill('PRINTER_MODE', 'stub');
fill('MAIL_MODE', 'stub');
fill('CLOSE_PRINT_FAILURE', 'queue');
// Saturday 3 October 2026, after the Lusaka open. The seeded roster covers this morning.
fill('DESK_NOW', '2026-10-03T10:00:00+02:00');

require(path.join(__dirname, '..', 'backend', 'server.js'));
