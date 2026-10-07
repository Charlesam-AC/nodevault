const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { buildApp } = require('../server');
const { signSession } = require('../middleware/auth');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const PASSWORD = 'Vault-demo-2026';

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
  const master = await request(pool, {
    method: 'POST',
    path: '/api/auth/login/password',
    body: { email: 'admin@demo-bank.example', password: 'NodeVault-admin-2026' },
  });
  assert.equal(master.status, 200);
  return master.body.token;
}

async function login(pool, email) {
  const result = await request(pool, {
    method: 'POST',
    path: '/api/auth/login/password',
    body: { email, password: PASSWORD },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.token;
}

test.before(async () => {
  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'both';
  process.env.ENFORCED_CORPORATE_DOMAIN = 'demo-bank.example';
  await setupPools();
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

test('the master admin can add, rename, and remove a role, and built-in roles stay', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(await bcrypt.hash('135790', 4));
  await applicationPool.query(
    `UPDATE nodevault_users SET password_hash = $1 WHERE user_id = $2`,
    [passwordHash, desk.users.teller.user_id],
  );
  const token = await masterToken(applicationPool);

  const listed = await request(applicationPool, { path: '/api/roles', token });
  assert.equal(listed.status, 200);
  const head = listed.body.roles.find((role) => role.code === 'HEAD_TELLER_COORDINATOR');
  assert.equal(head.label, 'Head Teller');
  assert.equal(head.builtin, true);
  assert.ok(listed.body.roles.some((role) => role.code === 'BRANCH_MANAGER' && role.builtin));
  assert.ok(listed.body.roles.some((role) => role.code === 'BRANCH_ADMINISTRATOR' && role.builtin));

  const added = await request(applicationPool, {
    method: 'POST',
    path: '/api/roles',
    token,
    body: { display_name: 'Night Reader', power_tier: 'READER' },
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.tier, 'READER');
  assert.equal(added.body.builtin, false);

  const renamed = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/roles/${added.body.code}`,
    token,
    body: { display_name: 'Night Desk' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.label, 'Night Desk');

  const locked = await request(applicationPool, {
    method: 'DELETE',
    path: '/api/roles/HEAD_TELLER_COORDINATOR',
    token,
  });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.error, 'ROLE_LOCKED');

  const badTier = await request(applicationPool, {
    method: 'POST',
    path: '/api/roles',
    token,
    body: { display_name: 'Second Pen', power_tier: 'VAULT_CUSTODIAN' },
  });
  assert.equal(badTier.status, 400);
  assert.equal(badTier.body.error, 'INVALID_ROLE');

  const held = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Night Reader',
      work_email: 'night.reader@demo-bank.example',
      employee_id: 'NR-0001',
      two_letter_initials: 'N.R.',
      system_role: added.body.code,
      branch_id: desk.branchId,
      password: PASSWORD,
    },
  });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const blocked = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/roles/${added.body.code}`,
    token,
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'ROLE_IN_USE');

  const released = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/staff/${held.body.user_id}`,
    token,
    body: { system_role: 'TELLER' },
  });
  assert.equal(released.status, 200);
  const removed = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/roles/${added.body.code}`,
    token,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, true);

  const teller = await login(applicationPool, 'teller.desk@demo-bank.example');
  const refused = await request(applicationPool, {
    method: 'POST',
    path: '/api/roles',
    token: teller,
    body: { display_name: 'Side Door', power_tier: 'READER' },
  });
  assert.equal(refused.status, 403);

  const frozen = signSession({
    user_id: desk.users.admin.user_id,
    tenant_id: desk.tenantId,
    system_role: 'IT_SUPER_ADMIN',
    work_email: 'it.admin@demo-bank.example',
  });
  const frozenCall = await request(applicationPool, {
    method: 'GET',
    path: '/api/roles',
    token: frozen,
  });
  assert.equal(frozenCall.status, 403);
  assert.equal(frozenCall.body.error, 'ADMIN_FROZEN');
});

test('a branch administrator sees one vault and can close only that branch for a day', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(await bcrypt.hash('135790', 4));
  const token = await masterToken(applicationPool);
  const other = await applicationPool.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name, province, location_name)
     VALUES ($1, 'EM01', 'Empty Branch', 'Lusaka', 'Lusaka')
     RETURNING branch_id`,
    [desk.tenantId],
  );
  const otherId = Number(other.rows[0].branch_id);
  const foreign = await applicationPool.query(
    `INSERT INTO branch_vault_books (branch_id, tenant_id, book_class, business_date)
     VALUES ($1, $2, 'KWACHA_TREASURY', '2026-12-02')
     RETURNING book_id`,
    [otherId, desk.tenantId],
  );
  const created = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Kitwe Administrator',
      work_email: 'kitwe.admin@demo-bank.example',
      employee_id: 'BA-0001',
      two_letter_initials: 'K.A.',
      system_role: 'BRANCH_ADMINISTRATOR',
      branch_id: desk.branchId,
      password: PASSWORD,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const admin = await login(applicationPool, 'kitwe.admin@demo-bank.example');
  const me = await request(applicationPool, { path: '/api/me', token: admin });
  assert.equal(me.body.role_label, 'Branch Administrator');
  assert.equal(me.body.branch_scoped, true);

  const own = await request(applicationPool, {
    path: `/api/books/${desk.books.KWACHA_TREASURY}`,
    token: admin,
  });
  assert.equal(own.status, 200);
  const hidden = await request(applicationPool, {
    path: `/api/books/${foreign.rows[0].book_id}`,
    token: admin,
  });
  assert.equal(hidden.status, 404);

  const posted = await request(applicationPool, {
    method: 'POST',
    path: `/api/books/${desk.books.KWACHA_TREASURY}/entries`,
    token: admin,
    body: { accounting_label: 'CIT In', flow_direction: 'IN', amounts: { REISSUABLE: { K100: '1.00' } } },
  });
  assert.equal(posted.status, 403);

  const staff = await request(applicationPool, { path: '/api/staff', token: admin });
  assert.equal(staff.status, 200);
  assert.equal(staff.body.can_manage, false);
  assert.equal(staff.body.can_edit_roles, false);
  assert.ok(staff.body.users.every((user) => user.branch_id === desk.branchId));

  const day = await request(applicationPool, {
    method: 'POST',
    path: '/api/calendar/non-working',
    token: admin,
    body: {
      branch_ids: [desk.branchId],
      non_working_date: '2026-12-02',
      reason: 'Branch stocktake',
    },
  });
  assert.equal(day.status, 201, JSON.stringify(day.body));
  assert.deepEqual(day.body.branchIds, [desk.branchId]);

  const everyone = await request(applicationPool, {
    method: 'POST',
    path: '/api/calendar/non-working',
    token: admin,
    body: { all_branches: true, non_working_date: '2026-12-03', reason: 'Whole bank' },
  });
  assert.equal(everyone.status, 403);
  assert.equal(everyone.body.error, 'CLOSURE_SCOPE');

  const elsewhere = await request(applicationPool, {
    method: 'POST',
    path: '/api/calendar/non-working',
    token: admin,
    body: { branch_ids: [otherId], non_working_date: '2026-12-04', reason: 'Other branch' },
  });
  assert.equal(elsewhere.status, 403);
});

test('a branch manager can change branch roles and soft-close only that branch', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(await bcrypt.hash('135790', 4));
  const token = await masterToken(applicationPool);
  const branch = await request(applicationPool, {
    method: 'POST',
    path: '/api/branches',
    token,
    body: { branch_code: 'EM02', branch_name: 'Manager Branch', province: 'Lusaka', location_name: 'Lusaka' },
  });
  assert.equal(branch.status, 201, JSON.stringify(branch.body));
  const branchId = branch.body.branch_id;
  const manager = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Branch Manager',
      work_email: 'branch.manager@demo-bank.example',
      employee_id: 'BM-0001',
      two_letter_initials: 'B.M.',
      system_role: 'BRANCH_MANAGER',
      branch_id: branchId,
      password: PASSWORD,
    },
  });
  assert.equal(manager.status, 201, JSON.stringify(manager.body));
  const teller = await request(applicationPool, {
    method: 'POST',
    path: '/api/staff',
    token,
    body: {
      full_legal_name: 'Local Teller',
      work_email: 'local.teller@demo-bank.example',
      employee_id: 'LT-0001',
      two_letter_initials: 'L.T.',
      system_role: 'TELLER',
      branch_id: branchId,
      password: PASSWORD,
    },
  });
  assert.equal(teller.status, 201, JSON.stringify(teller.body));
  const session = await login(applicationPool, 'branch.manager@demo-bank.example');

  const promoted = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/staff/${teller.body.user_id}`,
    token: session,
    body: { system_role: 'BRANCH_ADMINISTRATOR' },
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(promoted.body.system_role, 'BRANCH_ADMINISTRATOR');

  const pen = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/staff/${teller.body.user_id}`,
    token: session,
    body: { system_role: 'VAULT_CUSTODIAN' },
  });
  assert.equal(pen.status, 403);
  assert.equal(pen.body.error, 'INVALID_ROLE');

  const moved = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/staff/${teller.body.user_id}`,
    token,
    body: { branch_id: desk.branchId, system_role: 'TELLER' },
  });
  assert.equal(moved.status, 200);

  const closed = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/branches/${branchId}`,
    token: session,
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.is_active, false);

  const reopened = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/branches/${branchId}`,
    token: session,
    body: { is_active: true },
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.is_active, true);

  const forever = await request(applicationPool, {
    method: 'PATCH',
    path: `/api/branches/${branchId}`,
    token: session,
    body: { permanently_closed: true },
  });
  assert.equal(forever.status, 403);
  assert.equal(forever.body.error, 'BRANCH_PERMANENT');

  const other = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/branches/${desk.branchId}`,
    token: session,
  });
  assert.equal(other.status, 403);
  assert.equal(other.body.error, 'WRONG_BRANCH');
});
