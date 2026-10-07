const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { buildApp } = require('../server');
const { signSession } = require('../middleware/auth');
const { KNOWN_BRANCHES, ensureKnownBranches } = require('../services/branches');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

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

test.before(async () => {
  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'both';
  process.env.ENFORCED_CORPORATE_DOMAIN = 'demo-bank.example';
  await setupPools();
});

test.after(async () => {
  await closePools();
});

test.beforeEach(async () => {
  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'both';
  process.env.ENFORCED_CORPORATE_DOMAIN = 'demo-bank.example';
  process.env.SEED_DEMO_DATA = 'true';
  await resetDatabase();
});

test('the published FNB Zambia list names Commercial Branch and Solwezi', () => {
  const commercial = KNOWN_BRANCHES.find((branch) => branch.branch_code === '260001');
  const solwezi = KNOWN_BRANCHES.find((branch) => branch.branch_code === '262823');
  const kitwe = KNOWN_BRANCHES.find((branch) => branch.branch_code === '260212');
  assert.equal(commercial.branch_name, 'Commercial Branch');
  assert.equal(commercial.province, 'Lusaka');
  assert.equal(solwezi.branch_name, 'Solwezi Branch');
  assert.equal(kitwe.location_name, 'Kitwe');
  for (const [code, name] of [
    ['260039', 'Acacia Premier Branch'],
    ['261238', 'Choma Branch'],
    ['262874', 'Kalumbila Branch'],
    ['260247', 'Kitwe Industrial Branch'],
    ['260261', 'Kitwe Private Clients'],
    ['260741', 'Luanshya Branch'],
    ['260061', 'Lusaka Private Clients'],
    ['263613', 'Mazabuka Branch'],
    ['262319', 'Mkushi Branch'],
  ]) {
    assert.equal(KNOWN_BRANCHES.find((branch) => branch.branch_code === code).branch_name, name);
  }
  assert.equal(KNOWN_BRANCHES.length, 23);
});

test('the master admin can add a branch, assign a person, and close it', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(await bcrypt.hash('135790', 4));
  const token = await masterToken(applicationPool);
  const seeded = await ensureKnownBranches(applicationPool);
  assert.equal(seeded.inserted, KNOWN_BRANCHES.length);
  const again = await ensureKnownBranches(applicationPool);
  assert.equal(again.inserted, 0);

  const listed = await request(applicationPool, { path: '/api/branches', token });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.can_manage, true);
  assert.ok(listed.body.branches.some((branch) => branch.branch_code === '260014' && branch.branch_name === 'Manda Hill Branch'));
  assert.ok(listed.body.branches.some((branch) => branch.branch_code === '261061'));

  const created = await request(applicationPool, {
    method: 'POST',
    path: '/api/branches',
    token,
    body: {
      branch_name: 'Arcades Desk',
      branch_code: '260099',
      province: 'Lusaka',
      location_name: 'Lusaka',
    },
  });
  assert.equal(created.status, 201);
  const duplicate = await request(applicationPool, {
    method: 'POST',
    path: '/api/branches',
    token,
    body: { branch_name: 'Arcades Again', branch_code: '260099', province: 'Lusaka', location_name: 'Lusaka' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'BRANCH_CODE_TAKEN');

  const blockedHome = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/branches/${desk.branchId}`,
    token,
  });
  assert.equal(blockedHome.status, 409);
  assert.equal(blockedHome.body.error, 'BRANCH_IN_USE');

  const assigned = await request(applicationPool, {
    method: 'POST',
    path: `/api/branches/${created.body.branch_id}/staff`,
    token,
    body: { user_id: desk.users.teller.user_id },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.branch_id, created.body.branch_id);
  const stillThere = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/branches/${created.body.branch_id}`,
    token,
  });
  assert.equal(stillThere.status, 409);

  const back = await request(applicationPool, {
    method: 'POST',
    path: `/api/branches/${desk.branchId}/staff`,
    token,
    body: { user_id: desk.users.teller.user_id },
  });
  assert.equal(back.status, 200);
  assert.equal(back.body.branch_id, desk.branchId);

  const closed = await request(applicationPool, {
    method: 'DELETE',
    path: `/api/branches/${created.body.branch_id}`,
    token,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.is_active, false);
  const staff = await request(applicationPool, { path: '/api/staff', token });
  assert.equal(staff.body.branches.some((branch) => branch.branch_code === '260099'), false);

  const custodian = signSession({
    user_id: desk.users.c1.user_id,
    tenant_id: desk.tenantId,
    system_role: 'VAULT_CUSTODIAN',
    work_email: 'charles.amulike@demo-bank.example',
  });
  const refused = await request(applicationPool, { path: '/api/branches', token: custodian });
  assert.equal(refused.status, 403);

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
      password: 'Vault-demo-2026',
    },
  });
  assert.equal(auditor.status, 201);
  const acting = await request(applicationPool, {
    method: 'POST',
    path: '/api/auth/act-as',
    token,
    body: { user_id: auditor.body.user_id },
  });
  const reading = await request(applicationPool, { path: '/api/branches', token: acting.body.token });
  assert.equal(reading.status, 200);
  assert.equal(reading.body.can_manage, false);
  assert.ok(reading.body.branches.some((branch) => branch.branch_name === 'Ndola Main Branch'));
  const actingWrite = await request(applicationPool, {
    method: 'POST',
    path: '/api/branches',
    token: acting.body.token,
    body: { branch_name: 'Should Fail', branch_code: '269999', province: 'Lusaka', location_name: 'Lusaka' },
  });
  assert.equal(actingWrite.status, 403);
  assert.equal(actingWrite.body.error, 'WRONG_ROLE');
});
