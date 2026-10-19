const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { buildApp } = require('../server');
const { signSession } = require('../middleware/auth');
const {
  assignAuditorBranches,
  setCurrentBranch,
  markPending,
  markLine,
  buildReview,
  signOff,
  reprintSignoff,
  branchGate,
} = require('../services/auditReview');
const { recordSurpriseCheck } = require('../services/surprise');
const { VaultError } = require('../services/errors');
const { DATE } = require('../fixtures/sampleLedger');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

let pinHash;

async function addAuditor(pool, desk, email = 'auditor.desk@demo-bank.example') {
  const inserted = await pool.query(
    `INSERT INTO nodevault_users (
       tenant_id, branch_id, work_email, full_legal_name, employee_id,
       two_letter_initials, system_role, is_active
     ) VALUES ($1,$2,$3,'Branch Auditor','AUD-0012','A.U.','AUDITOR',true)
     RETURNING user_id, work_email, full_legal_name, employee_id`,
    [desk.tenantId, desk.branchId, email],
  );
  return {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    userId: inserted.rows[0].user_id,
    role: 'AUDITOR',
    email: inserted.rows[0].work_email,
    fullLegalName: inserted.rows[0].full_legal_name,
    employeeId: inserted.rows[0].employee_id,
  };
}

function master(desk) {
  return {
    tenantId: desk.tenantId,
    userId: desk.users.admin.user_id,
    email: 'admin@demo-bank.example',
  };
}

async function lineCount(pool) {
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM vault_denomination_matrix_ledger');
  return result.rows[0].n;
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
  process.env.PRINTER_MODE = 'stub';
  process.env.PRINT_STUB_DIR = '/tmp/nodevault-prints-test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-32-characters-long';
});

test('an auditor works many branches one at a time', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const other = await applicationPool.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name)
     VALUES ($1, 'KT01', 'Kitwe Branch') RETURNING branch_id`,
    [desk.tenantId],
  );
  const auditor = await addAuditor(applicationPool, desk);
  await applicationPool.query(
    `UPDATE branches SET printer_target = '10.1.4.30' WHERE branch_id = $1`,
    [desk.branchId],
  );
  await assignAuditorBranches(applicationPool, master(desk), auditor.userId, [
    desk.branchId,
    other.rows[0].branch_id,
  ]);
  await assert.rejects(
    () => buildReview(applicationPool, desk.tenantId, other.rows[0].branch_id, DATE, DATE).then(() => (
      setCurrentBranch(applicationPool, auditor, 999999)
    )),
    (error) => error instanceof VaultError && error.code === 'AUDIT_BRANCH',
  );
  await assert.rejects(
    () => setCurrentBranch(applicationPool, auditor, 999999),
    (error) => error.code === 'AUDIT_BRANCH',
  );
  const first = await setCurrentBranch(applicationPool, auditor, desk.branchId);
  assert.equal(first.current_audit_branch_id, desk.branchId);
  await assert.rejects(
    () => setCurrentBranch(applicationPool, auditor, other.rows[0].branch_id),
    (error) => error.code === 'AUDIT_OPEN',
  );
  await markPending(applicationPool, auditor, desk.branchId);
  const moved = await setCurrentBranch(applicationPool, auditor, other.rows[0].branch_id);
  assert.equal(moved.current_audit_branch_id, other.rows[0].branch_id);
  const gate = await branchGate(applicationPool, desk.tenantId, auditor.userId, desk.branchId);
  assert.equal(gate.pending, true);
  assert.equal(gate.reviewed, false);
});

test('sign-off waits for every line, then freezes marks and prints without rolling back', async () => {
  const { applicationPool, adminPool } = pools();
  const desk = await createDesk(pinHash);
  await applicationPool.query(
    `UPDATE branches SET printer_target = '10.1.4.31' WHERE branch_id = $1`,
    [desk.branchId],
  );
  const auditor = await addAuditor(applicationPool, desk);
  await assignAuditorBranches(applicationPool, master(desk), auditor.userId, [desk.branchId]);
  await setCurrentBranch(applicationPool, auditor, desk.branchId);

  const early = await buildReview(applicationPool, desk.tenantId, desk.branchId, DATE, DATE);
  assert.equal(early.totals.find((row) => row.currency === 'ZMW').physical_minor, null);
  assert.ok(early.lines.length > 0);

  await applicationPool.query(
    `INSERT INTO mock_core_transactions (
       tenant_id, branch_id, book_class, business_date, posted_at, reference, description, currency_code, amount_minor
     ) VALUES
       ($1,$2,'KWACHA_TREASURY',$3,'2026-10-04T06:00:00Z','CORE-ONLY','No book line','ZMW',10000),
       ($1,$2,'KWACHA_TREASURY','2026-10-04','2026-10-03T10:00:00Z','NEXT-DAY','Outside the business date','ZMW',500)`,
    [desk.tenantId, desk.branchId, DATE],
  );
  await applicationPool.query(
    `UPDATE vault_denomination_matrix_ledger SET line_reference = 'CIT-100'
     WHERE book_id = $1 AND line_number = 2`,
    [desk.books.KWACHA_TREASURY],
  );
  await applicationPool.query(
    `INSERT INTO mock_core_transactions (
       tenant_id, branch_id, book_class, business_date, posted_at, reference, description, currency_code, amount_minor
     ) VALUES ($1,$2,'KWACHA_TREASURY',$3,'2026-10-03T08:00:00Z','CIT-100','Matched slip','ZMW',100)`,
    [desk.tenantId, desk.branchId, DATE],
  );
  await applicationPool.query(
    `INSERT INTO surprise_checks (
       tenant_id, branch_id, business_date, checked_at, checker_user_id, checker_name,
       checker_employee_id, checker_role, custodians_present
     ) VALUES ($1,$2,$3,'2026-10-04T04:00:00Z',$4,'Branch Auditor','AUD-0012','AUDITOR','[]'::jsonb)`,
    [desk.tenantId, desk.branchId, DATE, auditor.userId],
  );

  const review = await buildReview(applicationPool, desk.tenantId, desk.branchId, DATE, DATE);
  assert.equal(review.core_without_book.some((row) => row.reference === 'CORE-ONLY'), true);
  assert.equal(review.core_without_book.some((row) => row.reference === 'CIT-100'), false);
  assert.equal(review.core_without_book.some((row) => row.reference === 'NEXT-DAY'), false);
  assert.equal(review.surprise_checks.length, 0);

  await assert.rejects(
    () => signOff(applicationPool, auditor, desk.branchId, { from: DATE, to: DATE, comment: 'Done' }),
    (error) => error.code === 'SIGN_OFF_INCOMPLETE',
  );
  await assert.rejects(
    () => signOff(applicationPool, auditor, desk.branchId, { from: DATE, to: DATE, comment: '   ' }),
    (error) => error.code === 'SIGN_OFF_INCOMPLETE',
  );
  await assert.rejects(
    () => signOff(applicationPool, { ...auditor, email: 'demo@nodevault.local' }, desk.branchId, {
      from: DATE, to: DATE, comment: 'Done',
    }),
    (error) => error.code === 'WRONG_ROLE',
  );

  const before = await lineCount(applicationPool);
  for (const line of review.lines) {
    await markLine(applicationPool, auditor, desk.branchId, line.matrix_tx_id, {
      status: 'REVIEWED',
      comment: '',
    });
  }
  const commented = review.lines[1];
  const replaced = await markLine(applicationPool, auditor, desk.branchId, commented.matrix_tx_id, {
    status: 'MATCHED_WITH_DIFFERENCE',
    comment: 'CIT slip short',
    core_ref_kind: 'CIT_SLIP',
  });
  assert.equal(replaced.comment, 'CIT slip short');
  assert.equal(await lineCount(applicationPool), before);

  const counted = await recordSurpriseCheck(applicationPool, auditor, {
    checked_at: '2026-10-03T20:00:00.000Z',
    business_date: DATE,
    books: [
      { book_class: 'KWACHA_TREASURY', counted: { ZMW: '1656515.00' } },
      { book_class: 'FOREIGN_CURRENCY', counted: { EUR: '0.00', GBP: '0.00', USD: '8000.00', ZAR: '25000.00' } },
      { book_class: 'BANCS_TREASURY', counted: { EUR: '1500.00', GBP: '500.00', USD: '220.00', ZAR: '400.00' } },
    ],
  });
  assert.equal(counted.books[0].matched, true);
  const withCount = await buildReview(applicationPool, desk.tenantId, desk.branchId, DATE, DATE);
  const kwacha = withCount.totals.find((row) => row.book_class === 'KWACHA_TREASURY' && row.currency === 'ZMW');
  assert.equal(kwacha.physical_minor, '165651500');
  assert.ok(withCount.surprise_checks.length === 1);
  assert.equal(withCount.reviewed_without_comment, review.lines.length - 1);
  assert.equal(withCount.commented_lines.length, 1);

  const failed = await signOff(applicationPool, auditor, desk.branchId, {
    from: DATE,
    to: DATE,
    comment: 'Books agree with the core.',
  }, { printer: async () => { throw new Error('offline'); } });
  assert.equal(failed.print.status, 'FAILED');
  assert.equal(failed.full_legal_name, 'Branch Auditor');
  assert.equal(failed.employee_id, 'AUD-0012');
  const signoffs = await applicationPool.query('SELECT COUNT(*)::int AS n FROM audit_signoffs');
  assert.equal(signoffs.rows[0].n, 1);
  assert.equal(await lineCount(applicationPool), before);
  const event = await applicationPool.query(
    `SELECT event_type FROM audit_events WHERE event_type = 'AUDIT_SIGNED_OFF'`,
  );
  assert.equal(event.rowCount, 1);

  await assert.rejects(
    () => markLine(applicationPool, auditor, desk.branchId, commented.matrix_tx_id, {
      status: 'MATCHED',
      comment: 'too late',
    }),
    (error) => error.code === 'MARK_FROZEN',
  );
  await assert.rejects(
    () => adminPool.query(`UPDATE audit_signoffs SET end_comment = 'changed'`),
    /append-only/,
  );
  const reprinted = await reprintSignoff(applicationPool, auditor, failed.signoff_id);
  assert.equal(reprinted.status, 'SENT');
  assert.equal(await lineCount(applicationPool), before);
  const gate = await branchGate(applicationPool, desk.tenantId, auditor.userId, desk.branchId);
  assert.equal(gate.reviewed, true);
  assert.equal(gate.pending, false);
});

test('an auditor cannot post a book line', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const auditor = await addAuditor(applicationPool, desk);
  const app = buildApp(applicationPool);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const token = signSession({
      user_id: auditor.userId,
      tenant_id: desk.tenantId,
      system_role: 'AUDITOR',
      work_email: auditor.email,
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/books/${desk.books.KWACHA_TREASURY}/entries`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accounting_label: 'In', flow_direction: 'IN', amounts: {} }),
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error, 'WRONG_ROLE');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
