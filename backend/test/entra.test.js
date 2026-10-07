const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { buildApp } = require('../server');
const { openBreakGlass } = require('../services/breakglass');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const PASSWORD = 'Vault-demo-2026';
const ENV_KEYS = ['ENABLE_LOCAL_LOGIN', 'AUTH_MODE', 'ENFORCED_CORPORATE_DOMAIN'];
const savedEnv = {};

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function request(pool, { method, path, token, body }) {
  const app = buildApp(pool);
  const server = app.listen(0);
  const payload = body === undefined ? null : JSON.stringify(body);
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'both';
  process.env.ENFORCED_CORPORATE_DOMAIN = 'demo-bank.example';
  await setupPools();
});

test.after(async () => {
  restoreEnv();
  await closePools();
});

test('the IT super admin can turn Microsoft Entra off and on', async () => {
  await resetDatabase();
  const pinHash = await bcrypt.hash('135790', 6);
  const passwordHash = await bcrypt.hash(PASSWORD, 6);
  await createDesk(pinHash);
  const { applicationPool, adminPool } = pools();
  await adminPool.query(
    `UPDATE nodevault_users SET password_hash = $1 WHERE work_email = $2`,
    [passwordHash, 'charles.amulike@demo-bank.example'],
  );

  const custodian = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/login/password',
    body: { email: 'charles.amulike@demo-bank.example', password: PASSWORD },
  });
  assert.equal(custodian.status, 200);
  const refused = await request(applicationPool, {
    method: 'PUT',
    path: '/api/auth/entra',
    token: custodian.body.token,
    body: { enabled: false },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'WRONG_ROLE');

  const assertion = process.env.MOCK_ENTRA_ASSERTION;
  const opened = await openBreakGlass(applicationPool, {
    admin_email: 'it.admin@demo-bank.example',
    admin_assertion: assertion,
    custodian_one_email: 'charles.amulike@demo-bank.example',
    custodian_one_assertion: assertion,
    custodian_two_email: 'custodian.two@demo-bank.example',
    custodian_two_assertion: assertion,
  });

  const turnedOff = await request(applicationPool, {
    method: 'PUT',
    path: '/api/auth/entra',
    token: opened.token,
    body: { enabled: false },
  });
  assert.equal(turnedOff.status, 200);
  assert.equal(turnedOff.body.entraEnabled, false);

  const config = await request(applicationPool, { method: 'GET', path: '/api/public-config' });
  assert.equal(config.body.entraEnabled, false);

  const entra = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/login',
    body: { email: 'charles.amulike@demo-bank.example', assertion },
  });
  assert.equal(entra.status, 403);
  assert.equal(entra.body.error, 'ENTRA_DISABLED');

  const passwordStillWorks = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/login/password',
    body: { email: 'charles.amulike@demo-bank.example', password: PASSWORD },
  });
  assert.equal(passwordStillWorks.status, 200);

  const emergency = await openBreakGlass(applicationPool, {
    admin_email: 'it.admin@demo-bank.example',
    admin_assertion: assertion,
    custodian_one_email: 'charles.amulike@demo-bank.example',
    custodian_one_assertion: assertion,
    custodian_two_email: 'custodian.two@demo-bank.example',
    custodian_two_assertion: assertion,
  });
  assert.ok(emergency.token);

  process.env.ENABLE_LOCAL_LOGIN = 'false';
  const lastDoor = await request(applicationPool, {
    method: 'PUT',
    path: '/api/auth/entra',
    token: opened.token,
    body: { enabled: false },
  });
  assert.equal(lastDoor.status, 409);
  assert.equal(lastDoor.body.error, 'LAST_DOOR');
  process.env.ENABLE_LOCAL_LOGIN = 'true';

  const turnedOn = await request(applicationPool, {
    method: 'PUT',
    path: '/api/auth/entra',
    token: opened.token,
    body: { enabled: true },
  });
  assert.equal(turnedOn.status, 200);
  assert.equal(turnedOn.body.entraEnabled, true);

  const restored = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/login',
    body: { email: 'charles.amulike@demo-bank.example', assertion },
  });
  assert.equal(restored.status, 200);

  const audit = await applicationPool.query(
    `SELECT event_type FROM audit_events
     WHERE event_type IN ('ENTRA_DISABLED', 'ENTRA_ENABLED')
     ORDER BY audit_id`,
  );
  assert.deepEqual(audit.rows.map((row) => row.event_type), ['ENTRA_DISABLED', 'ENTRA_ENABLED']);
});
