const bcrypt = require('bcryptjs');
const { localLoginEnabled } = require('../middleware/auth');
const { isoWeekParts } = require('./week');
const { syncCatalogue } = require('./catalogue');
const { createBookWithRows } = require('./books');
const { recordAudit } = require('./audit');
const { DATE, kwachaRows, foreignRows, bancsRows } = require('../fixtures/sampleLedger');

async function seedDemo(db) {
  await syncCatalogue(db);
  const existing = await db.query('SELECT tenant_id FROM bank_tenants LIMIT 1');
  if (existing.rowCount > 0) {
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
    `INSERT INTO bank_tenants (bank_name, corporate_domain)
     VALUES ('Demo Commercial Bank', 'demo-bank.example')
     RETURNING tenant_id`,
  );
  const tenantId = tenant.rows[0].tenant_id;
  const branch = await db.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name)
     VALUES ($1, 'MB01', 'Main Branch')
     RETURNING branch_id`,
    [tenantId],
  );
  const branchId = branch.rows[0].branch_id;

  const people = [
    ['charles.amulike@demo-bank.example', 'Charles Amulike', 'CUST-0149', 'C.A.', 'VAULT_CUSTODIAN'],
    ['custodian.two@demo-bank.example', 'Secondary Custodian', 'CUST-0288', 'J.P.', 'VAULT_CUSTODIAN'],
    ['coordinator.mk@demo-bank.example', 'Head Teller Coordinator', 'TELL-0811', 'M.K.', 'HEAD_TELLER_COORDINATOR'],
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

  await db.query(
    `INSERT INTO system_control (tenant_id, initialized_at, it_admin_frozen)
     VALUES ($1, now(), true)`,
    [tenantId],
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

  await createBookWithRows(db, {
    tenantId, branchId, bookClass: 'KWACHA_TREASURY', businessDate: DATE, rows: kwachaRows,
  });
  await createBookWithRows(db, {
    tenantId, branchId, bookClass: 'FOREIGN_CURRENCY', businessDate: DATE, rows: foreignRows,
  });
  await createBookWithRows(db, {
    tenantId, branchId, bookClass: 'BANCS_TREASURY', businessDate: DATE, rows: bancsRows,
  });

  // Friday 2 October 2026 is the previous business day before the next Monday handover.
  // Those books are locked so the handover log has a Bal c/d to record. The open desk
  // remains the seeded Saturday sample.
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
    [fridayIds],
  );
  return { seeded: true, tenantId, branchId };
}

module.exports = { seedDemo };
