const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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

function request(pool, { method = 'GET', path, token, body }) {
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
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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
    req.end(payload || undefined);
  });
}

test('the master admin can open the desk as a staff member and return', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  process.env.SEED_DEMO_DATA = 'true';
  process.env.MASTER_ADMIN_EMAIL = 'admin@demo-bank.example';
  process.env.MASTER_ADMIN_PASSWORD = 'NodeVault-admin-2026';
  process.env.DEMO_CLOSING_PIN = '135790';
  const { ensureMasterAdmin } = require('../services/seed');
  await ensureMasterAdmin(applicationPool);
  await setPassword(CUSTODIAN);

  const master = await postPassword(applicationPool, {
    email: 'admin@demo-bank.example',
    password: 'NodeVault-admin-2026',
  });
  assert.equal(master.status, 200);
  const home = await request(applicationPool, { path: '/api/me', token: master.body.token });
  assert.equal(home.body.can_act_as, true);

  const custodianLogin = await postPassword(applicationPool, { email: CUSTODIAN, password: PASSWORD });
  const refused = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as',
    token: custodianLogin.body.token,
    body: { user_id: desk.users.c2.user_id },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'WRONG_ROLE');

  const blockedAdmin = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as',
    token: master.body.token,
    body: { user_id: desk.users.admin.user_id },
  });
  assert.equal(blockedAdmin.status, 403);

  const acting = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as',
    token: master.body.token,
    body: { user_id: desk.users.c1.user_id },
  });
  assert.equal(acting.status, 200);
  assert.equal(acting.body.user.system_role, 'VAULT_CUSTODIAN');
  assert.equal(acting.body.user.work_email, CUSTODIAN);
  const asCustodian = await request(applicationPool, { path: '/api/me', token: acting.body.token });
  assert.equal(asCustodian.body.system_role, 'VAULT_CUSTODIAN');
  assert.equal(asCustodian.body.acting_as, true);
  assert.equal(asCustodian.body.can_act_as, false);
  const books = await request(applicationPool, { path: '/api/books', token: acting.body.token });
  assert.equal(books.status, 200);
  assert.ok(books.body.books.some((book) => book.book_class === 'KWACHA_TREASURY'));

  const switched = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as',
    token: acting.body.token,
    body: { user_id: desk.users.coord.user_id },
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.user.system_role, 'HEAD_TELLER_COORDINATOR');
  const asCoordinator = await request(applicationPool, { path: '/api/me', token: switched.body.token });
  assert.equal(asCoordinator.status, 200);
  assert.equal(asCoordinator.body.acting_as, true);
  assert.equal(asCoordinator.body.system_role, 'HEAD_TELLER_COORDINATOR');
  const switchedBooks = await request(applicationPool, { path: '/api/books', token: switched.body.token });
  assert.equal(switchedBooks.status, 200);

  const missing = await request(applicationPool, { path: '/api/does-not-exist' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'NOT_FOUND');

  const back = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as/return',
    token: switched.body.token,
    body: {},
  });
  assert.equal(back.status, 200);
  assert.equal(back.body.user.system_role, 'IT_SUPER_ADMIN');
  const restored = await request(applicationPool, { path: '/api/me', token: back.body.token });
  assert.equal(restored.body.can_act_as, true);
  assert.equal(restored.body.acting_as, false);
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

test('the master admin and an acting custodian can post a line on the open book', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  process.env.SEED_DEMO_DATA = 'true';
  process.env.MASTER_ADMIN_EMAIL = 'admin@demo-bank.example';
  process.env.MASTER_ADMIN_PASSWORD = 'NodeVault-admin-2026';
  process.env.DEMO_CLOSING_PIN = '135790';
  const { ensureMasterAdmin } = require('../services/seed');
  const { ensureWorkingBooks } = require('../services/workingBooks');
  await ensureMasterAdmin(applicationPool);
  await setPassword(CUSTODIAN);
  await setPassword('teller.desk@demo-bank.example');
  await applicationPool.query(
    `UPDATE branch_vault_books
     SET status = 'BALANCED_CLOSED', closed_at = now()
     WHERE branch_id = $1`,
    [desk.branchId],
  );
  const opened = await ensureWorkingBooks(applicationPool, new Date('2026-10-07T10:00:00.000Z'));
  assert.equal(opened.ensured, true);
  const again = await ensureWorkingBooks(applicationPool, new Date('2026-10-07T10:00:00.000Z'));
  assert.ok(again.results[0].opened.every((item) => item.status === 'ALREADY'));

  const master = await postPassword(applicationPool, {
    email: 'admin@demo-bank.example',
    password: 'NodeVault-admin-2026',
  });
  const working = await applicationPool.query(
    `SELECT book_id FROM branch_vault_books
     WHERE branch_id = $1 AND book_class = 'KWACHA_TREASURY' AND business_date = '2026-10-07'`,
    [desk.branchId],
  );
  const bookId = working.rows[0].book_id;
  const line = {
    custodian_one_initials: 'C.A.',
    custodian_two_initials: 'J.P.',
    teller_coord_initials: 'M.K.',
    accounting_label: 'CIT In',
    flow_direction: 'IN',
    amounts: { REISSUABLE: { K100: '100.00' } },
  };
  const posted = await request(applicationPool, {
    method: 'POST',
    path: `/api/books/${bookId}/entries`,
    token: master.body.token,
    body: line,
  });
  assert.equal(posted.status, 201);

  const teller = await postPassword(applicationPool, {
    email: 'teller.desk@demo-bank.example',
    password: PASSWORD,
  });
  const refused = await request(applicationPool, {
    method: 'POST',
    path: `/api/books/${bookId}/entries`,
    token: teller.body.token,
    body: line,
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'WRONG_ROLE');

  const closed = await request(applicationPool, {
    method: 'POST',
    path: `/api/books/${desk.books.KWACHA_TREASURY}/entries`,
    token: master.body.token,
    body: line,
  });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, 'BOOK_CLOSED');

  const acting = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as',
    token: master.body.token,
    body: { user_id: desk.users.c1.user_id },
  });
  const second = await request(applicationPool, {
    method: 'POST',
    path: `/api/books/${bookId}/entries`,
    token: acting.body.token,
    body: { ...line, accounting_label: 'CIT Out', flow_direction: 'OUT', amounts: { REISSUABLE: { K100: '50.00' } } },
  });
  assert.equal(second.status, 201);

  const openView = await request(applicationPool, {
    path: `/api/books/${bookId}`,
    token: acting.body.token,
  });
  assert.equal(openView.body.square_required, true);
  assert.equal(openView.body.position.ZMW.display, 'K1,656,565.00');
  assert.ok(openView.body.rows.some((row) => row.accounting_label === 'CIT In' && row.in_or_out === 'CIT In' && row.reference === 'CIT In'));

  const vaulted = await request(applicationPool, {
    method: 'POST',
    path: `/api/books/${bookId}/entries`,
    token: acting.body.token,
    body: { ...line, accounting_label: 'In', flow_direction: 'IN', amounts: { REISSUABLE: { K100: '10.00' } } },
  });
  assert.equal(vaulted.status, 201);

  const squared = await request(applicationPool, {
    method: 'POST',
    path: `/api/books/${bookId}/square`,
    token: acting.body.token,
    body: line,
  });
  assert.equal(squared.status, 201);
  const balanced = await request(applicationPool, {
    path: `/api/books/${bookId}`,
    token: master.body.token,
  });
  assert.equal(balanced.body.square_required, false);
  assert.equal(balanced.body.rows.at(-1).accounting_label, 'Bal c/d');
  assert.equal(balanced.body.rows.at(-1).reference, 'Bal c/d');
  assert.equal(balanced.body.position.ZMW.display, 'K1,656,575.00');

  const cited = await request(applicationPool, {
    method: 'POST',
    path: `/api/books/${bookId}/entries`,
    token: acting.body.token,
    body: {
      ...line,
      accounting_label: 'CIT In',
      line_reference: 'CIT 14',
      flow_direction: 'IN',
      amounts: { REISSUABLE: { K100: '10.00' } },
    },
  });
  assert.equal(cited.status, 201);
  const withReference = await request(applicationPool, {
    path: `/api/books/${bookId}`,
    token: acting.body.token,
  });
  assert.ok(withReference.body.rows.some((row) => row.in_or_out === 'CIT In' && row.reference === 'CIT 14'));
  const earlier = withReference.body.rows.find((row) => row.accounting_label === 'CIT In' && row.reference === 'CIT In');
  assert.ok(earlier);
  const deskHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const deskApp = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.equal(deskHtml.includes('Seal or slip'), false);
  assert.equal(deskApp.includes('Seal or slip'), false);
  assert.match(deskApp, /if \(known\.has\(current\)\) input\.value = document\.getElementById\('entry-flow'\)\.value/);

  const deskView = await request(applicationPool, { path: '/api/books', token: master.body.token });
  assert.equal(deskView.body.businessDate, '2026-10-07');
  assert.ok(deskView.body.dates.some((item) => item.business_date === '2026-10-03' && item.status === 'BALANCED_CLOSED'));
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

test('a vault custodian can amend an open line and a closed book stays locked', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await setPassword(CUSTODIAN);
  await setPassword('teller.desk@demo-bank.example');
  await setPassword('coordinator.mk@demo-bank.example');
  const custodian = await postPassword(applicationPool, { email: CUSTODIAN, password: PASSWORD });
  const bookId = desk.books.KWACHA_TREASURY;
  const before = await request(applicationPool, {
    path: `/api/books/${bookId}`,
    token: custodian.body.token,
  });
  const line = before.body.rows.find((row) => row.flow_direction === 'IN');
  assert.ok(line);
  const amounts = JSON.parse(JSON.stringify(line.amounts));
  amounts.REISSUABLE = amounts.REISSUABLE || {};
  const kwacha = Number(String(amounts.REISSUABLE.K10 || '0').split('.')[0]) + 10;
  amounts.REISSUABLE.K10 = `${kwacha}.00`;
  const amended = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/books/${bookId}/entries/${line.line_number}`,
    token: custodian.body.token,
    body: {
      accounting_label: 'In',
      line_reference: 'Vault slip',
      flow_direction: 'IN',
      custodian_one_initials: 'C.A.',
      custodian_two_initials: 'J.P.',
      teller_coord_initials: 'M.K.',
      amounts,
    },
  });
  assert.equal(amended.status, 200);
  assert.ok(amended.body.carriedLines.length > 0);
  const after = await request(applicationPool, {
    path: `/api/books/${bookId}`,
    token: custodian.body.token,
  });
  const updated = after.body.rows.find((row) => row.line_number === line.line_number);
  assert.equal(updated.reference, 'Vault slip');
  assert.equal(updated.in_or_out, 'In');
  assert.equal(after.body.square_required, false);
  assert.notEqual(after.body.position.ZMW.display, before.body.position.ZMW.display);
  assert.match(updated.displays['TREASURY|GRAND|GRAND'], /^\+ K/);

  const turnedOut = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/books/${bookId}/entries/${line.line_number}`,
    token: custodian.body.token,
    body: {
      accounting_label: 'Out',
      line_reference: 'Vault slip',
      flow_direction: 'OUT',
      custodian_one_initials: 'C.A.',
      custodian_two_initials: 'J.P.',
      teller_coord_initials: 'M.K.',
      amounts: { REISSUABLE: { K10: '10.00' } },
    },
  });
  assert.equal(turnedOut.status, 200);
  assert.ok(turnedOut.body.carriedLines.length > 0);
  const outward = await request(applicationPool, {
    path: `/api/books/${bookId}`,
    token: custodian.body.token,
  });
  const outwardLine = outward.body.rows.find((row) => row.line_number === line.line_number);
  const outwardBalance = outward.body.rows.find((row) => (
    row.line_number > line.line_number && row.flow_direction === 'BAL'
  ));
  const inwardBalance = after.body.rows.find((row) => (
    row.line_number > line.line_number && row.flow_direction === 'BAL'
  ));
  assert.equal(outwardLine.in_or_out, 'Out');
  assert.equal(outwardLine.flow_direction, 'OUT');
  assert.equal(outwardLine.displays['TREASURY|GRAND|GRAND'], '- K10.00');
  assert.equal(outwardLine.displays['REISSUABLE|TOTAL|SUBTOTAL'], '- K10.00');
  assert.notEqual(
    outwardLine.displays['TREASURY|GRAND|GRAND'],
    updated.displays['TREASURY|GRAND|GRAND'],
  );
  assert.notEqual(
    outwardBalance.displays['TREASURY|GRAND|GRAND'],
    inwardBalance.displays['TREASURY|GRAND|GRAND'],
  );
  assert.notEqual(outward.body.position.ZMW.display, after.body.position.ZMW.display);

  const turnedBack = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/books/${bookId}/entries/${line.line_number}`,
    token: custodian.body.token,
    body: {
      accounting_label: 'In',
      line_reference: 'Vault slip',
      flow_direction: 'IN',
      custodian_one_initials: 'C.A.',
      custodian_two_initials: 'J.P.',
      teller_coord_initials: 'M.K.',
      amounts,
    },
  });
  assert.equal(turnedBack.status, 200);
  const restored = await request(applicationPool, {
    path: `/api/books/${bookId}`,
    token: custodian.body.token,
  });
  const restoredLine = restored.body.rows.find((row) => row.line_number === line.line_number);
  assert.equal(restoredLine.in_or_out, 'In');
  assert.match(restoredLine.displays['TREASURY|GRAND|GRAND'], /^\+ K/);
  assert.equal(restored.body.position.ZMW.display, after.body.position.ZMW.display);

  const teller = await postPassword(applicationPool, {
    email: 'teller.desk@demo-bank.example',
    password: PASSWORD,
  });
  const tellerAttempt = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/books/${bookId}/entries/${line.line_number}`,
    token: teller.body.token,
    body: {
      accounting_label: 'In',
      line_reference: 'Teller slip',
      flow_direction: 'IN',
      custodian_one_initials: 'C.A.',
      custodian_two_initials: 'J.P.',
      teller_coord_initials: 'M.K.',
      amounts,
    },
  });
  assert.equal(tellerAttempt.status, 403);
  assert.equal(tellerAttempt.body.error, 'WRONG_ROLE');

  const coordinator = await postPassword(applicationPool, {
    email: 'coordinator.mk@demo-bank.example',
    password: PASSWORD,
  });
  const coordinatorAttempt = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/books/${bookId}/entries/${line.line_number}`,
    token: coordinator.body.token,
    body: {
      accounting_label: 'In',
      line_reference: 'Teller slip',
      flow_direction: 'IN',
      custodian_one_initials: 'C.A.',
      custodian_two_initials: 'J.P.',
      teller_coord_initials: 'M.K.',
      amounts,
    },
  });
  assert.equal(coordinatorAttempt.status, 403);

  process.env.SEED_DEMO_DATA = 'true';
  process.env.MASTER_ADMIN_EMAIL = 'admin@demo-bank.example';
  process.env.MASTER_ADMIN_PASSWORD = 'NodeVault-admin-2026';
  process.env.DEMO_CLOSING_PIN = '135790';
  const { ensureMasterAdmin } = require('../services/seed');
  await ensureMasterAdmin(applicationPool);
  const master = await postPassword(applicationPool, {
    email: 'admin@demo-bank.example',
    password: 'NodeVault-admin-2026',
  });
  const adminAmend = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/books/${bookId}/entries/${line.line_number}`,
    token: master.body.token,
    body: {
      accounting_label: 'In',
      line_reference: 'Admin test',
      flow_direction: 'IN',
      custodian_one_initials: 'C.A.',
      custodian_two_initials: 'J.P.',
      teller_coord_initials: 'M.K.',
      amounts,
    },
  });
  assert.equal(adminAmend.status, 200);
  const adminView = await request(applicationPool, {
    path: `/api/books/${bookId}`,
    token: master.body.token,
  });
  assert.equal(
    adminView.body.rows.find((row) => row.line_number === line.line_number).reference,
    'Admin test',
  );

  await applicationPool.query(
    `UPDATE branch_vault_books SET status = 'BALANCED_CLOSED', closed_at = now() WHERE book_id = $1`,
    [bookId],
  );
  const closed = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/books/${bookId}/entries/${line.line_number}`,
    token: custodian.body.token,
    body: {
      accounting_label: 'In',
      line_reference: 'Too late',
      flow_direction: 'IN',
      custodian_one_initials: 'C.A.',
      custodian_two_initials: 'J.P.',
      teller_coord_initials: 'M.K.',
      amounts,
    },
  });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, 'BOOK_CLOSED');
});
