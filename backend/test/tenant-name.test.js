const test = require('node:test');
const assert = require('node:assert/strict');
const { seedDemo, ensureCeremony } = require('../services/seed');
const { setupPools, resetDatabase, closePools, pools } = require('./helpers');

test.before(async () => {
  await setupPools();
});

test.after(async () => {
  await closePools();
});

test.beforeEach(async () => {
  await resetDatabase();
  process.env.SEED_DEMO_DATA = 'true';
  process.env.DEMO_CLOSING_PIN = '135790';
  process.env.AUTH_MODE = 'entra';
  process.env.ENABLE_LOCAL_LOGIN = 'false';
});

test('the demo tenant is named FNB Zambia Limited', async () => {
  const { applicationPool } = pools();
  const seeded = await seedDemo(applicationPool);
  assert.equal(seeded.seeded, true);
  const named = await applicationPool.query(
    'SELECT bank_name, corporate_domain FROM bank_tenants',
  );
  assert.equal(named.rowCount, 1);
  assert.equal(named.rows[0].bank_name, 'FNB Zambia Limited');
  assert.equal(named.rows[0].corporate_domain, 'demo-bank.example');

  await applicationPool.query(`UPDATE bank_tenants SET bank_name = 'Demo Commercial Bank'`);
  await ensureCeremony(applicationPool);
  const renamed = await applicationPool.query('SELECT bank_name FROM bank_tenants');
  assert.equal(renamed.rows[0].bank_name, 'FNB Zambia Limited');
});
