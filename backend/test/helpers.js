const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createPool } = require('../db');
const { syncCatalogue } = require('../services/catalogue');
const { ensureMovementOptions } = require('../services/movements');
const { createBookWithRows } = require('../services/books');
const { isoWeekParts } = require('../services/week');
const { DATE, kwachaRows, foreignRows, bancsRows } = require('../fixtures/sampleLedger');

const initSql = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'init.sql'), 'utf8');

let adminPool;
let applicationPool;

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function adminConfig() {
  return {
    host: process.env.TEST_DB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT || process.env.DB_PUBLISH_PORT || 54329),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.TEST_DB_NAME || 'nodevault_test',
  };
}

function appConfig() {
  return {
    ...adminConfig(),
    user: 'nodevault_app',
    password: process.env.APP_DB_PASSWORD,
  };
}

async function setupPools() {
  if (!process.env.POSTGRES_USER || !process.env.APP_DB_PASSWORD) {
    throw new Error('Copy .env.example to .env before running tests');
  }
  adminPool = createPool(adminConfig());
  await adminPool.query('SELECT 1');
  const password = sqlLiteral(process.env.APP_DB_PASSWORD);
  const exists = await adminPool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'nodevault_app'`);
  if (exists.rowCount === 0) {
    await adminPool.query(`CREATE ROLE nodevault_app LOGIN PASSWORD ${password}`);
  } else {
    await adminPool.query(`ALTER ROLE nodevault_app WITH LOGIN PASSWORD ${password}`);
  }
  const testDb = process.env.TEST_DB_NAME || 'nodevault_test';
  await adminPool.query(`GRANT CONNECT ON DATABASE ${testDb} TO nodevault_app`);
  applicationPool = createPool(appConfig());
  await applicationPool.query('SELECT 1');
}

async function resetDatabase() {
  await adminPool.query(`
    DROP TABLE IF EXISTS
      surprise_check_books,
      surprise_checks,
      book_narrations,
      movement_options,
      desk_roles,
      gazetted_holiday_cancellations,
      gazetted_holidays,
      non_working_closure_cancellations,
      non_working_closure_branches,
      non_working_closures,
      post_assignments,
      handover_logs,
      carry_forward_flags,
      rotation_schedules,
      dispatch_outbox,
      audit_events,
      ledger_amount_cells,
      vault_denomination_matrix_ledger,
      break_glass_sessions,
      weekly_coordinator_assignments,
      mock_core_positions,
      denomination_catalogue,
      branch_vault_books,
      system_control,
      nodevault_users,
      branches,
      bank_tenants
    CASCADE;
    DROP FUNCTION IF EXISTS nodevault_user_email_domain() CASCADE;
    DROP FUNCTION IF EXISTS nodevault_reject_ledger_mutation() CASCADE;
    DROP FUNCTION IF EXISTS nodevault_reject_closed_book_insert() CASCADE;
    DROP FUNCTION IF EXISTS nodevault_guard_book() CASCADE;
    DROP FUNCTION IF EXISTS nodevault_verify_entry_arithmetic() CASCADE;
    DROP FUNCTION IF EXISTS nodevault_reject_handover_mutation() CASCADE;
    DROP FUNCTION IF EXISTS nodevault_reject_narration_mutation() CASCADE;
    DROP FUNCTION IF EXISTS nodevault_reject_calendar_mutation() CASCADE;
    DROP TYPE IF EXISTS nodevault_closure_scope CASCADE;
    DROP TYPE IF EXISTS nodevault_user_role CASCADE;
    DROP TYPE IF EXISTS nodevault_book_class CASCADE;
    DROP TYPE IF EXISTS nodevault_book_status CASCADE;
  `);
  await adminPool.query(initSql);
  await syncCatalogue(applicationPool);
}

async function createDesk(pinHash, options = {}) {
  const db = applicationPool;
  const tenant = await db.query(
    `INSERT INTO bank_tenants (bank_name, corporate_domain, logo_label)
     VALUES ('Desk Bank', 'demo-bank.example', 'FNB') RETURNING tenant_id`,
  );
  const tenantId = tenant.rows[0].tenant_id;
  const branch = await db.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name, province, location_name)
     VALUES ($1, 'MB01', 'Main Branch', 'Lusaka', 'Lusaka') RETURNING branch_id`,
    [tenantId],
  );
  const branchId = branch.rows[0].branch_id;
  const people = [
    ['c1', 'charles.amulike@demo-bank.example', 'Charles Amulike', 'CUST-0149', 'C.A.', 'VAULT_CUSTODIAN'],
    ['c2', 'custodian.two@demo-bank.example', 'Secondary Custodian', 'CUST-0288', 'J.P.', 'VAULT_CUSTODIAN'],
    ['coord', 'coordinator.mk@demo-bank.example', 'Head Teller', 'TELL-0811', 'M.K.', 'HEAD_TELLER_COORDINATOR'],
    ['teller', 'teller.desk@demo-bank.example', 'Branch Teller', 'TELL-1004', 'T.D.', 'TELLER'],
    ['admin', 'it.admin@demo-bank.example', 'IT Super Admin', 'IT-0001', 'I.T.', 'IT_SUPER_ADMIN'],
    ['rom', 'rom@demo-bank.example', 'Regional Operations Manager', 'ROM-0001', 'R.M.', 'REGIONAL_OPS_MANAGER'],
  ];
  const users = {};
  for (const [key, email, name, employeeId, initials, role] of people) {
    const inserted = await db.query(
      `INSERT INTO nodevault_users (
         tenant_id, branch_id, work_email, full_legal_name, employee_id,
         two_letter_initials, system_role, closing_pin_hash, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       RETURNING user_id, work_email, full_legal_name, system_role`,
      [tenantId, branchId, email, name, employeeId, initials, role, pinHash],
    );
    users[key] = inserted.rows[0];
  }
  await db.query(
    `INSERT INTO system_control (tenant_id, initialized_at, it_admin_frozen)
     VALUES ($1, now(), true)`,
    [tenantId],
  );
  await ensureMovementOptions(db, tenantId);
  const week = isoWeekParts(DATE);
  await db.query(
    `INSERT INTO weekly_coordinator_assignments
       (tenant_id, branch_id, coordinator_user_id, iso_year, iso_week)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, branchId, users.coord.user_id, week.isoYear, week.isoWeek],
  );
  const roster = [
    ['CUSTODIAN_ONE', users.c1.user_id],
    ['CUSTODIAN_TWO', users.c2.user_id],
    ['HEAD_TELLER', users.coord.user_id],
  ];
  for (const [postCode, userId] of roster) {
    await db.query(
      `INSERT INTO rotation_schedules (tenant_id, branch_id, post_code, cadence, anchor_date)
       VALUES ($1, $2, $3, 'WEEKLY', '2026-09-28')`,
      [tenantId, branchId, postCode],
    );
    await db.query(
      `INSERT INTO post_assignments
         (tenant_id, branch_id, post_code, user_id, period_start, period_end)
       VALUES ($1, $2, $3, $4, '2026-09-28', '2026-10-04')`,
      [tenantId, branchId, postCode, userId],
    );
  }
  const books = {};
  if (options.withBooks !== false) {
    books.KWACHA_TREASURY = await createBookWithRows(db, {
      tenantId, branchId, bookClass: 'KWACHA_TREASURY', businessDate: DATE, rows: kwachaRows,
    });
    books.FOREIGN_CURRENCY = await createBookWithRows(db, {
      tenantId, branchId, bookClass: 'FOREIGN_CURRENCY', businessDate: DATE, rows: foreignRows,
    });
    books.BANCS_TREASURY = await createBookWithRows(db, {
      tenantId, branchId, bookClass: 'BANCS_TREASURY', businessDate: DATE, rows: bancsRows,
    });
  }
  return { tenantId, branchId, users, books, pin: '135790' };
}

async function closePools() {
  if (applicationPool) await applicationPool.end();
  if (adminPool) await adminPool.end();
  applicationPool = null;
  adminPool = null;
}

function pools() {
  return { adminPool, applicationPool };
}

module.exports = {
  setupPools,
  resetDatabase,
  createDesk,
  closePools,
  pools,
};
