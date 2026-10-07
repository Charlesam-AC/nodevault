const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { resolvePrincipal } = require('../middleware/auth');
const { buildApp } = require('../server');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const PASSWORD = 'Vault-demo-2026';
const CUSTODIAN = 'charles.amulike@demo-bank.example';
const ENV_KEYS = [
  'ENABLE_LOCAL_LOGIN',
  'AUTH_MODE',
  'LOCAL_LOGIN_MAX_FAILURES',
  'LOCAL_LOGIN_LOCKOUT_MINUTES',
  'ENFORCED_CORPORATE_DOMAIN',
];

let pinHash;
let passwordHash;
const savedEnv = {};

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function enableLocalLogin() {
  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'both';
  process.env.LOCAL_LOGIN_MAX_FAILURES = '5';
  process.env.LOCAL_LOGIN_LOCKOUT_MINUTES = '15';
  process.env.ENFORCED_CORPORATE_DOMAIN = 'demo-bank.example';
}

async function setPassword(email) {
  const { adminPool } = pools();
  await adminPool.query(
    `UPDATE nodevault_users
     SET password_hash = $1, failed_login_count = 0, locked_until = NULL
     WHERE work_email = $2`,
    [passwordHash, email],
  );
}

function postPassword(pool, body) {
  const app = buildApp(pool);
  const server = app.listen(0);
  const payload = JSON.stringify(body);
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/auth/login/password',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        server.close();
        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
      });
    });
    req.on('error', (error) => {
      server.close();
      reject(error);
    });
    req.end(payload);
  });
}

test.before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  await setupPools();
  pinHash = await bcrypt.hash('135790', 6);
  passwordHash = await bcrypt.hash(PASSWORD, 6);
});

test.after(async () => {
  restoreEnv();
  await closePools();
});

test.beforeEach(async () => {
  enableLocalLogin();
  await resetDatabase();
});

test('password sign-in opens a desk session', async () => {
  const { applicationPool, adminPool } = pools();
  await createDesk(pinHash);
  await setPassword(CUSTODIAN);
  const stored = await adminPool.query(
    `SELECT closing_pin_hash, password_hash FROM nodevault_users WHERE work_email = $1`,
    [CUSTODIAN],
  );
  assert.notEqual(stored.rows[0].closing_pin_hash, stored.rows[0].password_hash);

  const result = await postPassword(applicationPool, { email: CUSTODIAN, password: PASSWORD });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.system_role, 'VAULT_CUSTODIAN');
  const principal = await resolvePrincipal(applicationPool, result.body.token);
  assert.equal(principal.email, CUSTODIAN);
  assert.equal(principal.role, 'VAULT_CUSTODIAN');

  const counter = await applicationPool.query(
    `SELECT failed_login_count FROM nodevault_users WHERE work_email = $1`,
    [CUSTODIAN],
  );
  assert.equal(Number(counter.rows[0].failed_login_count), 0);
});

test('a wrong password is rejected and counted', async () => {
  const { applicationPool } = pools();
  await createDesk(pinHash);
  await setPassword(CUSTODIAN);
  const result = await postPassword(applicationPool, { email: CUSTODIAN, password: 'not-the-demo-password' });
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'ACCESS_DENIED');
  const counter = await applicationPool.query(
    `SELECT failed_login_count, locked_until FROM nodevault_users WHERE work_email = $1`,
    [CUSTODIAN],
  );
  assert.equal(Number(counter.rows[0].failed_login_count), 1);
  assert.equal(counter.rows[0].locked_until, null);
});

test('password sign-in is refused when the flag or auth mode turns it off', async () => {
  const { applicationPool } = pools();
  await createDesk(pinHash);
  await setPassword(CUSTODIAN);

  process.env.ENABLE_LOCAL_LOGIN = 'false';
  const disabled = await postPassword(applicationPool, { email: CUSTODIAN, password: PASSWORD });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.body.error, 'LOCAL_LOGIN_DISABLED');

  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'entra';
  const entraOnly = await postPassword(applicationPool, { email: CUSTODIAN, password: PASSWORD });
  assert.equal(entraOnly.status, 403);
  assert.equal(entraOnly.body.error, 'LOCAL_LOGIN_DISABLED');

  const counter = await applicationPool.query(
    `SELECT failed_login_count FROM nodevault_users WHERE work_email = $1`,
    [CUSTODIAN],
  );
  assert.equal(Number(counter.rows[0].failed_login_count), 0);
});

test('repeated wrong passwords lock the account', async () => {
  const { applicationPool } = pools();
  await createDesk(pinHash);
  await setPassword(CUSTODIAN);
  process.env.LOCAL_LOGIN_MAX_FAILURES = '3';

  const first = await postPassword(applicationPool, { email: CUSTODIAN, password: 'wrong-1' });
  const second = await postPassword(applicationPool, { email: CUSTODIAN, password: 'wrong-2' });
  const third = await postPassword(applicationPool, { email: CUSTODIAN, password: 'wrong-3' });
  assert.equal(first.body.error, 'ACCESS_DENIED');
  assert.equal(second.body.error, 'ACCESS_DENIED');
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'LOCKED');

  const correctWhileLocked = await postPassword(applicationPool, { email: CUSTODIAN, password: PASSWORD });
  assert.equal(correctWhileLocked.status, 429);
  assert.equal(correctWhileLocked.body.error, 'LOCKED');

  const row = await applicationPool.query(
    `SELECT failed_login_count, locked_until FROM nodevault_users WHERE work_email = $1`,
    [CUSTODIAN],
  );
  assert.equal(Number(row.rows[0].failed_login_count), 3);
  assert.ok(new Date(row.rows[0].locked_until).getTime() > Date.now());
});

test('the master admin password opens an IT super admin session while the seeded admin stays frozen', async () => {
  const { applicationPool } = pools();
  await createDesk(pinHash);
  const saved = {
    SEED_DEMO_DATA: process.env.SEED_DEMO_DATA,
    MASTER_ADMIN_EMAIL: process.env.MASTER_ADMIN_EMAIL,
    MASTER_ADMIN_PASSWORD: process.env.MASTER_ADMIN_PASSWORD,
    DEMO_CLOSING_PIN: process.env.DEMO_CLOSING_PIN,
  };
  process.env.SEED_DEMO_DATA = 'true';
  process.env.MASTER_ADMIN_EMAIL = 'admin@demo-bank.example';
  process.env.MASTER_ADMIN_PASSWORD = 'NodeVault-admin-2026';
  process.env.DEMO_CLOSING_PIN = '135790';
  try {
    const { ensureMasterAdmin } = require('../services/seed');
    const created = await ensureMasterAdmin(applicationPool);
    assert.equal(created.ensured, true);
    const again = await ensureMasterAdmin(applicationPool);
    assert.equal(again.ensured, false);

    const master = await postPassword(applicationPool, {
      email: 'admin@demo-bank.example',
      password: 'NodeVault-admin-2026',
    });
    assert.equal(master.status, 200);
    assert.equal(master.body.user.system_role, 'IT_SUPER_ADMIN');
    assert.equal(master.body.user.work_email, 'admin@demo-bank.example');
    const principal = await resolvePrincipal(applicationPool, master.body.token);
    assert.equal(principal.email, 'admin@demo-bank.example');
    assert.equal(principal.role, 'IT_SUPER_ADMIN');
    assert.equal(principal.breakGlassId, null);

    await setPassword('it.admin@demo-bank.example');
    const frozen = await postPassword(applicationPool, {
      email: 'it.admin@demo-bank.example',
      password: PASSWORD,
    });
    assert.equal(frozen.status, 403);
    assert.equal(frozen.body.error, 'ADMIN_FROZEN');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a frozen IT super admin cannot use a correct directory password', async () => {
  const { applicationPool } = pools();
  await createDesk(pinHash);
  await setPassword('it.admin@demo-bank.example');
  const result = await postPassword(applicationPool, {
    email: 'it.admin@demo-bank.example',
    password: PASSWORD,
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'ADMIN_FROZEN');
});

test('password sign-in keeps the corporate domain restriction', async () => {
  const { applicationPool } = pools();
  await createDesk(pinHash);
  await setPassword(CUSTODIAN);
  process.env.ENFORCED_CORPORATE_DOMAIN = 'other-bank.example';
  const result = await postPassword(applicationPool, { email: CUSTODIAN, password: PASSWORD });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'DOMAIN_REJECTED');
});
