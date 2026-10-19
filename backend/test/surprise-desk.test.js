const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { getBookView } = require('../services/ledger');
const { VaultError } = require('../services/errors');
const { DATE } = require('../fixtures/sampleLedger');
const {
  recordSurpriseCheck,
  listSurpriseChecks,
  setSurpriseArchived,
  deleteSurpriseCheck,
  assignSurpriseChecker,
  withdrawSurpriseAssignment,
  surpriseAssignmentView,
} = require('../services/surprise');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

let pinHash;

async function addUser(pool, desk, email, name, employeeId, initials, role) {
  const inserted = await pool.query(
    `INSERT INTO nodevault_users (
       tenant_id, branch_id, work_email, full_legal_name, employee_id,
       two_letter_initials, system_role, closing_pin_hash, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
     RETURNING user_id, employee_id, full_legal_name, system_role, work_email`,
    [desk.tenantId, desk.branchId, email, name, employeeId, initials, role, pinHash],
  );
  return inserted.rows[0];
}

function asUser(desk, row, role) {
  return {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    userId: row.user_id,
    role: role || row.system_role,
    email: row.work_email,
    fullLegalName: row.full_legal_name,
    employeeId: row.employee_id,
    actorUserId: null,
  };
}

async function countedBooks(pool, desk) {
  const books = [];
  for (const bookClass of ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY']) {
    const view = await getBookView(pool, desk.tenantId, desk.books[bookClass]);
    const counted = {};
    for (const [currency, value] of Object.entries(view.position)) {
      if (currency === 'error') continue;
      counted[currency] = value.decimal;
    }
    books.push({ book_class: bookClass, counted });
  }
  return books;
}

async function fingerprint(pool) {
  const rows = await pool.query(
    `SELECT accounting_label, line_number, book_id
     FROM vault_denomination_matrix_ledger
     ORDER BY book_id, line_number`,
  );
  return rows.rows.map((row) => `${row.book_id}:${row.line_number}:${row.accounting_label}`).join('|');
}

test.before(async () => {
  await setupPools();
  pinHash = await bcrypt.hash('135790', 6);
});

test.after(async () => {
  await closePools();
});

test.beforeEach(async () => {
  await resetDatabase();
  process.env.MASTER_ADMIN_EMAIL = 'admin@demo-bank.example';
});

test('a master admin can archive or delete a surprise check without moving a balance', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const auditor = await addUser(
    applicationPool, desk, 'auditor.desk@demo-bank.example', 'Branch Auditor', 'AUD-0012', 'A.U.', 'AUDITOR',
  );
  const checker = asUser(desk, auditor, 'AUDITOR');
  const before = await fingerprint(applicationPool);
  const recorded = await recordSurpriseCheck(applicationPool, checker, {
    checked_at: '2026-10-03T12:30:00.000Z',
    business_date: DATE,
    books: await countedBooks(applicationPool, desk),
  });
  assert.match(recorded.books.find((book) => book.book_class === 'KWACHA_TREASURY').system_totals[0].figure, /^ZMW /);
  const admin = {
    email: 'admin@demo-bank.example',
    tenantId: desk.tenantId,
    role: 'IT_SUPER_ADMIN',
    actorUserId: null,
  };
  await setSurpriseArchived(applicationPool, admin, recorded.check_id, true);
  const hidden = await listSurpriseChecks(applicationPool, desk.tenantId, desk.branchId, DATE);
  assert.equal(hidden.length, 0);
  const archived = await listSurpriseChecks(applicationPool, desk.tenantId, desk.branchId, DATE, { archived: true });
  assert.equal(archived.length, 1);
  await setSurpriseArchived(applicationPool, admin, recorded.check_id, false);
  const restored = await listSurpriseChecks(applicationPool, desk.tenantId, desk.branchId, DATE);
  assert.equal(restored.length, 1);
  await deleteSurpriseCheck(applicationPool, admin, recorded.check_id);
  const gone = await applicationPool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM surprise_checks) AS checks,
       (SELECT COUNT(*)::int FROM surprise_check_books) AS books`,
  );
  assert.equal(gone.rows[0].checks, 0);
  assert.equal(gone.rows[0].books, 0);
  assert.equal(await fingerprint(applicationPool), before);

  const again = await recordSurpriseCheck(applicationPool, checker, {
    checked_at: '2026-10-03T13:00:00.000Z',
    business_date: DATE,
    books: await countedBooks(applicationPool, desk),
  });
  await assert.rejects(
    () => setSurpriseArchived(applicationPool, checker, again.check_id, true),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );
  await assert.rejects(
    () => deleteSurpriseCheck(applicationPool, asUser(desk, desk.users.c1, 'VAULT_CUSTODIAN'), again.check_id),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );
  await assert.rejects(
    () => setSurpriseArchived(applicationPool, { ...admin, actorUserId: auditor.user_id }, again.check_id, true),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );
});

test('a branch administrator assigns the surprise count and the slip uses that person', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const admin = await addUser(
    applicationPool, desk, 'branch.admin@demo-bank.example', 'Branch Admin', 'BA-0100', 'B.A.', 'BRANCH_ADMINISTRATOR',
  );
  const teller = desk.users.teller;
  const manager = await addUser(
    applicationPool, desk, 'branch.manager@demo-bank.example', 'Branch Manager', 'BM-0101', 'B.M.', 'BRANCH_MANAGER',
  );
  const assigner = asUser(desk, admin, 'BRANCH_ADMINISTRATOR');
  const assigned = await assignSurpriseChecker(applicationPool, assigner, {
    business_date: DATE,
    user_id: teller.user_id,
  });
  assert.equal(assigned.employee_id, 'TELL-1004');
  const replacement = await addUser(
    applicationPool, desk, 'reader.desk@demo-bank.example', 'Branch Reader', 'RD-0102', 'R.D.', 'READER',
  );
  const replaced = await assignSurpriseChecker(applicationPool, assigner, {
    business_date: DATE,
    user_id: replacement.user_id,
  });
  assert.equal(replaced.employee_id, 'RD-0102');
  const view = await surpriseAssignmentView(applicationPool, assigner, DATE);
  assert.equal(view.candidates.some((person) => person.employee_id === 'CUST-0149'), false);
  assert.equal(view.candidates.some((person) => person.employee_id === 'IT-0001'), false);
  await assert.rejects(
    () => assignSurpriseChecker(applicationPool, assigner, {
      business_date: DATE,
      user_id: desk.users.c1.user_id,
    }),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );
  await assert.rejects(
    () => assignSurpriseChecker(applicationPool, assigner, {
      business_date: DATE,
      user_id: desk.users.admin.user_id,
    }),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );
  await assert.rejects(
    () => assignSurpriseChecker(applicationPool, asUser(desk, manager, 'BRANCH_MANAGER'), {
      business_date: DATE,
      user_id: teller.user_id,
    }),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );
  const counter = asUser(desk, replacement, 'READER');
  const recorded = await recordSurpriseCheck(applicationPool, counter, {
    checked_at: '2026-10-03T12:30:00.000Z',
    business_date: DATE,
    books: await countedBooks(applicationPool, desk),
  });
  assert.equal(recorded.checker_employee_id, 'RD-0102');
  assert.equal(recorded.checker_name, 'Branch Reader');
  await withdrawSurpriseAssignment(applicationPool, assigner, DATE);
  const cleared = await surpriseAssignmentView(applicationPool, assigner, DATE);
  assert.equal(cleared.assignment, null);
  await assert.rejects(
    async () => recordSurpriseCheck(applicationPool, counter, {
      checked_at: '2026-10-03T15:00:00.000Z',
      business_date: DATE,
      books: await countedBooks(applicationPool, desk),
    }),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );
});
