const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { buildApp } = require('../server');
const { signSession } = require('../middleware/auth');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const PASSWORD = 'Vault-demo-2026';
const PIN = '246810';

let pinHash;
let passwordHash;

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
    req.end(payload || undefined);
  });
}

async function masterToken(pool) {
  process.env.SEED_DEMO_DATA = 'true';
  process.env.MASTER_ADMIN_EMAIL = 'admin@demo-bank.example';
  process.env.MASTER_ADMIN_PASSWORD = 'NodeVault-admin-2026';
  process.env.DEMO_CLOSING_PIN = '135790';
  process.env.PIN_BCRYPT_ROUNDS = '4';
  const { ensureMasterAdmin } = require('../services/seed');
  await ensureMasterAdmin(pool);
  const { adminPool } = pools();
  await adminPool.query(
    `UPDATE nodevault_users SET password_hash = $1 WHERE work_email = $2`,
    [passwordHash, 'charles.amulike@demo-bank.example'],
  );
  const master = await request(pool, {
    method: 'POST',
    path: '/api/auth/login/password',
    body: { email: 'admin@demo-bank.example', password: 'NodeVault-admin-2026' },
  });
  assert.equal(master.status, 200);
  return master.body.token;
}

test.before(async () => {
  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'both';
  process.env.ENFORCED_CORPORATE_DOMAIN = 'demo-bank.example';
  await setupPools();
  pinHash = await bcrypt.hash('135790', 4);
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

test.after(async () => {
  await closePools();
});

test.beforeEach(async () => {
  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'both';
  process.env.ENFORCED_CORPORATE_DOMAIN = 'demo-bank.example';
  process.env.PIN_BCRYPT_ROUNDS = '4';
  await resetDatabase();
});

test('the master admin can add, assign, and remove staff, and the auditor can read the register', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const token = await masterToken(applicationPool);
  const branch = await applicationPool.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name, province, location_name)
     VALUES ($1, 'KT01', 'Kitwe Branch', 'Copperbelt', 'Kitwe')
     RETURNING branch_id`,
    [desk.tenantId],
  );
  const kitwe = Number(branch.rows[0].branch_id);

  const outside = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Outside Auditor',
      work_email: 'outside.auditor@other-bank.example',
      employee_id: 'AUD-0090',
      two_letter_initials: 'O.A.',
      system_role: 'AUDITOR',
      branch_id: desk.branchId,
      password: PASSWORD,
    },
  });
  assert.equal(outside.status, 400);
  assert.equal(outside.body.error, 'DOMAIN_REJECTED');

  const auditor = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Night Auditor',
      work_email: 'night.auditor@demo-bank.example',
      employee_id: 'AUD-0099',
      two_letter_initials: 'N.A.',
      system_role: 'AUDITOR',
      branch_id: desk.branchId,
      password: PASSWORD,
    },
  });
  assert.equal(auditor.status, 201);
  assert.equal(auditor.body.system_role, 'AUDITOR');

  const relief = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Relief Night',
      work_email: 'relief.night@demo-bank.example',
      employee_id: 'CUST-0440',
      two_letter_initials: 'R.N.',
      system_role: 'VAULT_CUSTODIAN',
      branch_id: desk.branchId,
      password: PASSWORD,
      closing_pin: PIN,
    },
  });
  assert.equal(relief.status, 201);

  const tellerLogin = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/login/password',
    body: { email: 'teller.desk@demo-bank.example', password: PASSWORD },
  });
  assert.equal(tellerLogin.status, 401);

  const custodianLogin = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/login/password',
    body: { email: 'charles.amulike@demo-bank.example', password: PASSWORD },
  });
  assert.equal(custodianLogin.status, 200);
  const custodianRead = await request(applicationPool, {
    path: '/api/staff',
    token: custodianLogin.body.token,
  });
  assert.equal(custodianRead.status, 403);
  assert.equal(custodianRead.body.error, 'WRONG_ROLE');

  const sameStart = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff/assignments',
    token,
    body: {
      user_id: relief.body.user_id,
      post_code: 'CUSTODIAN_ONE',
      branch_id: desk.branchId,
      period_start: '2026-09-28',
      period_end: '2026-10-04',
    },
  });
  assert.equal(sameStart.status, 409);
  assert.equal(sameStart.body.error, 'ASSIGNMENT_OVERLAP');

  const assigned = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff/assignments',
    token,
    body: {
      user_id: relief.body.user_id,
      post_code: 'CUSTODIAN_ONE',
      branch_id: desk.branchId,
      period_start: '2099-01-01',
      period_end: '2099-02-01',
    },
  });
  assert.equal(assigned.status, 201);

  const second = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Second Relief',
      work_email: 'second.relief@demo-bank.example',
      employee_id: 'CUST-0441',
      two_letter_initials: 'S.N.',
      system_role: 'VAULT_CUSTODIAN',
      branch_id: kitwe,
      password: PASSWORD,
      closing_pin: PIN,
    },
  });
  assert.equal(second.status, 201);
  const takeover = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff/assignments',
    token,
    body: {
      user_id: second.body.user_id,
      post_code: 'CUSTODIAN_ONE',
      branch_id: desk.branchId,
      period_start: '2099-01-10',
      period_end: '2099-01-20',
    },
  });
  assert.equal(takeover.status, 201);
  const shortened = await applicationPool.query(
    `SELECT period_end::text AS period_end
     FROM post_assignments
     WHERE user_id = $1 AND post_code = 'CUSTODIAN_ONE'`,
    [relief.body.user_id],
  );
  assert.equal(shortened.rows[0].period_end, '2099-01-09');
  const moved = await applicationPool.query(
    'SELECT branch_id FROM nodevault_users WHERE user_id = $1',
    [second.body.user_id],
  );
  assert.equal(Number(moved.rows[0].branch_id), desk.branchId);

  const roleBlocked = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/staff/${second.body.user_id}`,
    token,
    body: { system_role: 'TELLER' },
  });
  assert.equal(roleBlocked.status, 409);
  assert.equal(roleBlocked.body.error, 'POST_HELD');

  const removedBlocked = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/staff/${relief.body.user_id}`,
    token,
  });
  assert.equal(removedBlocked.status, 409);
  assert.equal(removedBlocked.body.error, 'POST_HELD');

  const spare = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Spare Teller',
      work_email: 'spare.teller@demo-bank.example',
      employee_id: 'TELL-2200',
      two_letter_initials: 'S.T.',
      system_role: 'TELLER',
      branch_id: kitwe,
      password: PASSWORD,
    },
  });
  assert.equal(spare.status, 201);
  const movedTeller = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/staff/${spare.body.user_id}`,
    token,
    body: { branch_id: desk.branchId, system_role: 'TELLER' },
  });
  assert.equal(movedTeller.status, 200);
  assert.equal(movedTeller.body.branch_id, desk.branchId);

  const removed = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/staff/${spare.body.user_id}`,
    token,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.is_active, false);
  const directory = await request(applicationPool, { path: '/api/directory', token });
  assert.equal(directory.body.users.some((user) => user.user_id === spare.body.user_id), false);
  const signedOut = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/login/password',
    body: { email: 'spare.teller@demo-bank.example', password: PASSWORD },
  });
  assert.equal(signedOut.status, 401);

  const home = await request(applicationPool, { path: '/api/me', token });
  const self = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/staff/${home.body.user_id}`,
    token,
  });
  assert.equal(self.status, 403);
  assert.equal(self.body.error, 'PROTECTED_USER');

  const frozen = signSession({
    user_id: desk.users.admin.user_id,
    tenant_id: desk.tenantId,
    system_role: 'IT_SUPER_ADMIN',
    work_email: 'it.admin@demo-bank.example',
  });
  const frozenWrite = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token: frozen,
    body: {
      full_legal_name: 'Should Fail',
      work_email: 'should.fail@demo-bank.example',
      employee_id: 'AUD-0100',
      two_letter_initials: 'S.F.',
      system_role: 'AUDITOR',
      branch_id: desk.branchId,
      password: PASSWORD,
    },
  });
  assert.equal(frozenWrite.status, 403);
  assert.equal(frozenWrite.body.error, 'ADMIN_FROZEN');

  const actingCustodian = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as',
    token,
    body: { user_id: desk.users.c1.user_id },
  });
  assert.equal(actingCustodian.status, 200);
  const actingWrite = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token: actingCustodian.body.token,
    body: {
      full_legal_name: 'Should Fail',
      work_email: 'should.fail@demo-bank.example',
      employee_id: 'AUD-0100',
      two_letter_initials: 'S.F.',
      system_role: 'AUDITOR',
      branch_id: desk.branchId,
      password: PASSWORD,
    },
  });
  assert.equal(actingWrite.status, 403);
  assert.equal(actingWrite.body.error, 'WRONG_ROLE');

  const actingAuditor = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as',
    token: actingCustodian.body.token,
    body: { user_id: auditor.body.user_id },
  });
  assert.equal(actingAuditor.status, 200);
  const roster = await request(applicationPool, {
    path: '/api/staff',
    token: actingAuditor.body.token,
  });
  assert.equal(roster.status, 200);
  assert.equal(roster.body.can_manage, false);
  assert.equal(roster.body.users.some((user) => user.work_email === 'spare.teller@demo-bank.example' && user.is_active === false), true);
  assert.equal(
    roster.body.users.some((user) => user.user_id === relief.body.user_id && user.assignments.some((item) => item.coverage === 'current' || item.coverage === 'recent' || item.coverage === 'upcoming')),
    true,
  );
  const auditorWrite = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/staff/${spare.body.user_id}`,
    token: actingAuditor.body.token,
  });
  assert.equal(auditorWrite.status, 403);
  assert.equal(auditorWrite.body.error, 'WRONG_ROLE');
});
