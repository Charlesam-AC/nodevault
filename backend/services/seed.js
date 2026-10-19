const bcrypt = require('bcryptjs');
const { localLoginEnabled } = require('../middleware/auth');
const { isoWeekParts } = require('./week');
const { syncCatalogue } = require('./catalogue');
const { createBookWithRows } = require('./books');
const { recordAudit } = require('./audit');
const { ensureMovementOptions } = require('./movements');
const { DATE, kwachaRows, foreignRows, bancsRows } = require('../fixtures/sampleLedger');

async function seedDemo(db) {
  await syncCatalogue(db);
  const existing = await db.query('SELECT tenant_id FROM bank_tenants LIMIT 1');
  if (existing.rowCount > 0) {
    await ensureCeremony(db);
    const books = await db.query(
      `SELECT COUNT(DISTINCT book_class)::int AS classes
       FROM branch_vault_books
       WHERE tenant_id = $1`,
      [existing.rows[0].tenant_id],
    );
    if (books.rows[0].classes >= 3) return { seeded: false };
    throw new Error('Demo tenant is present but the three treasury books were not seeded. Reset the database volume.');
  }

  const pin = process.env.DEMO_CLOSING_PIN;
  const rounds = Number(process.env.PIN_BCRYPT_ROUNDS || 10);
  if (!pin) throw new Error('DEMO_CLOSING_PIN is required when SEED_DEMO_DATA=true');
  const pinHash = await bcrypt.hash(pin, rounds);
  let passwordHash = null;
  if (localLoginEnabled()) {
    const password = process.env.DEMO_PASSWORD || '';
    if (password.length < 10) {
      throw new Error('DEMO_PASSWORD must be at least 10 characters when local login is enabled');
    }
    if (password === pin) {
      throw new Error('DEMO_PASSWORD must be different from DEMO_CLOSING_PIN');
    }
    passwordHash = await bcrypt.hash(password, rounds);
  }

  const tenant = await db.query(
    `INSERT INTO bank_tenants (bank_name, corporate_domain, logo_label)
     VALUES ('FNB Zambia Limited', 'demo-bank.example', 'FNB')
     RETURNING tenant_id`,
  );
  const tenantId = tenant.rows[0].tenant_id;
  const branch = await db.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name, province, location_name)
     VALUES ($1, 'MB01', 'Main Branch', 'Lusaka', 'Lusaka')
     RETURNING branch_id`,
    [tenantId],
  );
  const branchId = branch.rows[0].branch_id;
  await db.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name, province, location_name)
     VALUES ($1, 'CB01', 'Kitwe Branch', 'Copperbelt', 'Kitwe')`,
    [tenantId],
  );

  const people = [
    ['charles.amulike@demo-bank.example', 'Charles Amulike', 'CUST-0149', 'C.A.', 'VAULT_CUSTODIAN'],
    ['custodian.two@demo-bank.example', 'Secondary Custodian', 'CUST-0288', 'J.P.', 'VAULT_CUSTODIAN'],
    ['coordinator.mk@demo-bank.example', 'Head Teller', 'TELL-0811', 'M.K.', 'HEAD_TELLER_COORDINATOR'],
    ['teller.desk@demo-bank.example', 'Branch Teller', 'TELL-1004', 'T.D.', 'TELLER'],
    ['auditor.desk@demo-bank.example', 'Branch Auditor', 'AUD-0012', 'A.U.', 'AUDITOR'],
    ['it.admin@demo-bank.example', 'IT Super Admin', 'IT-0001', 'I.T.', 'IT_SUPER_ADMIN'],
    ['rom@demo-bank.example', 'Regional Operations Manager', 'ROM-0001', 'R.M.', 'REGIONAL_OPS_MANAGER'],
    ['custodian.relief@demo-bank.example', 'Relief Custodian', 'CUST-0301', 'R.C.', 'VAULT_CUSTODIAN'],
    ['custodian.relief.two@demo-bank.example', 'Second Relief Custodian', 'CUST-0302', 'S.R.', 'VAULT_CUSTODIAN'],
    ['coordinator.relief@demo-bank.example', 'Relief Coordinator', 'TELL-0902', 'R.K.', 'HEAD_TELLER_COORDINATOR'],
  ];
  const ids = {};
  for (const [email, name, employeeId, initials, role] of people) {
    const inserted = await db.query(
      `INSERT INTO nodevault_users (
         tenant_id, branch_id, work_email, full_legal_name, employee_id,
         two_letter_initials, system_role, closing_pin_hash, password_hash, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       RETURNING user_id`,
      [tenantId, branchId, email, name, employeeId, initials, role, pinHash, passwordHash],
    );
    ids[role] = ids[role] || inserted.rows[0].user_id;
    ids[email] = inserted.rows[0].user_id;
  }

  const entraEnabled = String(process.env.AUTH_MODE || 'both').toLowerCase() !== 'local';
  await db.query(
    `INSERT INTO system_control (tenant_id, initialized_at, it_admin_frozen, entra_enabled)
     VALUES ($1, now(), true, $2)`,
    [tenantId, entraEnabled],
  );
  await recordAudit(db, {
    tenantId,
    eventType: 'SYSTEM_INITIALIZED',
    actorUserIds: [ids['it.admin@demo-bank.example']],
    detail: { it_admin_frozen: true },
  });

  const week = isoWeekParts(DATE);
  await db.query(
    `INSERT INTO weekly_coordinator_assignments
       (tenant_id, branch_id, coordinator_user_id, iso_year, iso_week)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, branchId, ids['coordinator.mk@demo-bank.example'], week.isoYear, week.isoWeek],
  );

  const schedules = [
    ['CUSTODIAN_ONE', 'FORTNIGHTLY', null, '2026-09-28', '2026-10-11', ids['charles.amulike@demo-bank.example']],
    ['CUSTODIAN_TWO', 'FORTNIGHTLY', null, '2026-09-28', '2026-10-11', ids['custodian.two@demo-bank.example']],
    ['HEAD_TELLER', 'WEEKLY', null, '2026-09-28', '2026-10-04', ids['coordinator.mk@demo-bank.example']],
  ];
  for (const [postCode, cadence, customDays, anchor, periodEnd, userId] of schedules) {
    await db.query(
      `INSERT INTO rotation_schedules
         (tenant_id, branch_id, post_code, cadence, custom_days, anchor_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, branchId, postCode, cadence, customDays, anchor],
    );
    await db.query(
      `INSERT INTO post_assignments
         (tenant_id, branch_id, post_code, user_id, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, branchId, postCode, userId, anchor, periodEnd],
    );
  }

  // Saturday 3 October 2026 is a business day. The photographed sample is locked
  // and is the Bal c/d that Monday 5 October brings forward. Friday is locked as
  // the source a Saturday morning would roll, but these Saturday lines are the
  // sample itself, so the morning job does not insert a second Bal b/f.
  const saturdayIds = [];
  for (const [bookClass, rows] of [
    ['KWACHA_TREASURY', kwachaRows],
    ['FOREIGN_CURRENCY', foreignRows],
    ['BANCS_TREASURY', bancsRows],
  ]) {
    saturdayIds.push(await createBookWithRows(db, {
      tenantId, branchId, bookClass, businessDate: DATE, rows,
    }));
  }
  const friday = '2026-10-02';
  const fridayIds = [];
  for (const [bookClass, rows] of [
    ['KWACHA_TREASURY', kwachaRows],
    ['FOREIGN_CURRENCY', foreignRows],
    ['BANCS_TREASURY', bancsRows],
  ]) {
    fridayIds.push(await createBookWithRows(db, {
      tenantId, branchId, bookClass, businessDate: friday, rows,
    }));
  }
  await db.query(
    `UPDATE branch_vault_books
     SET status = 'BALANCED_CLOSED', closed_at = now()
     WHERE book_id = ANY($1::bigint[])`,
    [[...saturdayIds, ...fridayIds]],
  );
  await ensureMovementOptions(db, tenantId);
  await ensureMasterAdmin(db);
  return { seeded: true, tenantId, branchId };
}

async function ensureCeremony(db) {
  const tenants = await db.query(
    `SELECT tenant_id, corporate_domain, logo_label, bank_name FROM bank_tenants`,
  );
  for (const tenant of tenants.rows) {
    await ensureMovementOptions(db, tenant.tenant_id);
    await db.query(
      `UPDATE bank_tenants
       SET logo_file = 'fnb-acacia.png'
       WHERE tenant_id = $1 AND logo_file = 'fnb-logo-placeholder.png'`,
      [tenant.tenant_id],
    );
    if (tenant.corporate_domain === 'demo-bank.example' && tenant.bank_name === 'Demo Commercial Bank') {
      await db.query(
        `UPDATE bank_tenants SET bank_name = 'FNB Zambia Limited' WHERE tenant_id = $1`,
        [tenant.tenant_id],
      );
    }
    if (!tenant.logo_label && tenant.corporate_domain === 'demo-bank.example') {
      await db.query(
        `UPDATE bank_tenants SET logo_label = 'FNB' WHERE tenant_id = $1`,
        [tenant.tenant_id],
      );
    }
  }
}

// The seeded IT super admin stays frozen. This account is the one password
// that can open an IT super admin session without a break-glass window.
async function ensureMasterAdmin(db) {
  if (process.env.SEED_DEMO_DATA !== 'true' || !localLoginEnabled()) return { ensured: false };
  const email = String(process.env.MASTER_ADMIN_EMAIL || 'admin@demo-bank.example').trim().toLowerCase();
  if (!email) return { ensured: false };
  const password = process.env.MASTER_ADMIN_PASSWORD || 'NodeVault-admin-2026';
  if (password.length < 10) {
    throw new Error('MASTER_ADMIN_PASSWORD must be at least 10 characters');
  }
  const pin = process.env.DEMO_CLOSING_PIN || '';
  if (password === pin) {
    throw new Error('MASTER_ADMIN_PASSWORD must be different from DEMO_CLOSING_PIN');
  }
  const existing = await db.query(
    'SELECT user_id FROM nodevault_users WHERE work_email = $1',
    [email],
  );
  if (existing.rowCount > 0) return { ensured: false, userId: existing.rows[0].user_id };
  const tenant = await db.query('SELECT tenant_id FROM bank_tenants ORDER BY tenant_id LIMIT 1');
  if (!tenant.rowCount) return { ensured: false };
  const tenantId = tenant.rows[0].tenant_id;
  const branch = await db.query(
    'SELECT branch_id FROM branches WHERE tenant_id = $1 ORDER BY branch_id LIMIT 1',
    [tenantId],
  );
  const rounds = Number(process.env.PIN_BCRYPT_ROUNDS || 10);
  const passwordHash = await bcrypt.hash(password, rounds);
  const inserted = await db.query(
    `INSERT INTO nodevault_users (
       tenant_id, branch_id, work_email, full_legal_name, employee_id,
       two_letter_initials, system_role, password_hash, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,'IT_SUPER_ADMIN',$7,true)
     RETURNING user_id`,
    [
      tenantId,
      branch.rows[0] ? branch.rows[0].branch_id : null,
      email,
      'Master Admin',
      'ADM-0001',
      'M.A.',
      passwordHash,
    ],
  );
  await recordAudit(db, {
    tenantId,
    eventType: 'MASTER_ADMIN_CREATED',
    actorUserIds: [inserted.rows[0].user_id],
    detail: { work_email: email },
  });
  return { ensured: true, userId: inserted.rows[0].user_id };
}

module.exports = { seedDemo, ensureMasterAdmin, ensureCeremony };
