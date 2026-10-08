const { VaultError } = require('./errors');
const { isMasterAdmin } = require('../middleware/auth');
const { recordAudit } = require('./audit');
const { zonedParts } = require('./calendar');
const { BOOK_ORDER } = require('./books');
const { assignmentCovering } = require('./rotation');
const {
  loadRows,
  runningPosition,
  cellsFromMap,
  positionByCurrency,
} = require('./ledger');
const { toMinor } = require('./money');
const {
  figuresFromMinors,
  surpriseSentence,
  compareFigures,
  formatStamp,
} = require('./narration');
const { renderSurpriseSlip } = require('./documents');
const { deliver } = require('./printJobs');

function canConductSurprise(user) {
  if (!user) return false;
  if (user.actorUserId) {
    return user.role === 'AUDITOR' || user.role === 'REGIONAL_OPS_MANAGER';
  }
  if (isMasterAdmin({ work_email: user.email })) return true;
  return user.role === 'AUDITOR' || user.role === 'REGIONAL_OPS_MANAGER';
}

function assertCanConduct(user) {
  if (!canConductSurprise(user)) {
    throw new VaultError(
      'WRONG_ROLE',
      'A surprise cash check is recorded by an auditor or the regional operations manager',
      403,
    );
  }
}

function lusakaDate(value) {
  return zonedParts(value instanceof Date ? value : new Date(value), 'Africa/Lusaka').isoDate;
}

async function systemFigures(db, book) {
  const rows = await loadRows(db, book.book_id);
  const map = runningPosition(rows);
  const minors = positionByCurrency(book.book_class, cellsFromMap(book.book_class, map));
  return figuresFromMinors(book.book_class, minors);
}

function countedFigures(bookClass, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultError('INVALID_COUNT', 'Each book needs a counted total for every currency');
  }
  const minors = {};
  for (const currency of figuresFromMinors(bookClass, {}).map((item) => item.currency)) {
    if (raw[currency] === undefined || raw[currency] === null || String(raw[currency]).trim() === '') {
      throw new VaultError('INVALID_COUNT', `Enter the counted ${currency} total`);
    }
    try {
      minors[currency] = toMinor(String(raw[currency]));
    } catch (error) {
      throw new VaultError('INVALID_COUNT', error.message);
    }
  }
  return figuresFromMinors(bookClass, minors);
}

async function custodiansPresent(db, tenantId, branchId, businessDate) {
  const seats = ['CUSTODIAN_ONE', 'CUSTODIAN_TWO'];
  const present = [];
  for (const postCode of seats) {
    const row = await assignmentCovering(db, tenantId, branchId, postCode, businessDate);
    if (!row) continue;
    present.push({
      postCode,
      fullLegalName: row.full_legal_name,
      employeeId: row.employee_id,
      role: row.system_role,
    });
  }
  return present;
}

async function resolveCheckBranch(db, user) {
  if (user.role === 'AUDITOR' && user.userId) {
    const row = await db.query(
      `SELECT current_audit_branch_id FROM nodevault_users WHERE user_id = $1 AND tenant_id = $2`,
      [user.userId, user.tenantId],
    );
    const current = row.rows[0] && row.rows[0].current_audit_branch_id;
    if (current) {
      const assigned = await db.query(
        `SELECT 1 FROM auditor_branches WHERE tenant_id = $1 AND user_id = $2 AND branch_id = $3`,
        [user.tenantId, user.userId, current],
      );
      if (!assigned.rowCount) {
        throw new VaultError('AUDIT_BRANCH', 'That branch is not assigned to this auditor', 403);
      }
      return Number(current);
    }
  }
  if (!user.branchId) {
    throw new VaultError('NO_BRANCH', 'This profile is not attached to a branch', 409);
  }
  return Number(user.branchId);
}

async function recordSurpriseCheck(db, user, body) {
  assertCanConduct(user);
  const branchId = await resolveCheckBranch(db, user);
  const checkedAt = body.checked_at ? new Date(body.checked_at) : new Date();
  if (Number.isNaN(checkedAt.getTime())) {
    throw new VaultError('INVALID_TIME', 'The check time is not a real date');
  }
  const businessDate = body.business_date || lusakaDate(checkedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new VaultError('INVALID_TIME', 'The book date must be YYYY-MM-DD');
  }
  const books = await db.query(
    `SELECT book_id, book_class, status, business_date::text AS business_date
     FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3`,
    [user.tenantId, branchId, businessDate],
  );
  if (books.rowCount !== 3) {
    throw new VaultError('NO_BOOK', `There is no full set of books for ${businessDate}`, 409);
  }
  for (const book of books.rows) {
    if (book.status !== 'OPEN' && book.status !== 'BALANCED_CLOSED') {
      throw new VaultError('BOOK_STATUS', 'A surprise check uses an open or closed book', 409);
    }
  }
  const submitted = new Map((body.books || []).map((item) => [item.book_class, item.counted]));
  const checker = {
    fullLegalName: user.fullLegalName,
    employeeId: user.employeeId,
    role: user.role,
  };
  const present = await custodiansPresent(db, user.tenantId, branchId, businessDate);
  if (present.some((person) => person.employeeId === user.employeeId)) {
    throw new VaultError('WRONG_ROLE', 'A custodian on duty cannot surprise-check that cash', 403);
  }
  const lines = [];
  for (const bookClass of BOOK_ORDER) {
    const book = books.rows.find((item) => item.book_class === bookClass);
    const system = await systemFigures(db, book);
    const counted = countedFigures(bookClass, submitted.get(bookClass));
    const differences = compareFigures(system, counted);
    lines.push({
      book,
      system,
      counted,
      matched: differences.length === 0,
      differences,
      narration: surpriseSentence({
        figures: system,
        differences,
        checker,
        at: checkedAt,
      }),
    });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO surprise_checks (
         tenant_id, branch_id, business_date, checked_at,
         checker_user_id, checker_name, checker_employee_id, checker_role,
         custodians_present
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING check_id`,
      [
        user.tenantId,
        branchId,
        businessDate,
        checkedAt.toISOString(),
        user.userId,
        checker.fullLegalName,
        checker.employeeId,
        checker.role,
        JSON.stringify(present),
      ],
    );
    const checkId = Number(inserted.rows[0].check_id);
    for (const line of lines) {
      await client.query(
        `INSERT INTO surprise_check_books (
           check_id, book_id, book_class, system_totals, counted_totals, matched, narration_text
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
        [
          checkId,
          line.book.book_id,
          line.book.book_class,
          JSON.stringify(line.system),
          JSON.stringify(line.counted),
          line.matched,
          line.narration,
        ],
      );
    }
    await recordAudit(client, {
      tenantId: user.tenantId,
      eventType: 'SURPRISE_CHECK_RECORDED',
      actorUserIds: [user.userId],
      detail: {
        check_id: checkId,
        business_date: businessDate,
        checked_at: checkedAt.toISOString(),
        matched: lines.every((line) => line.matched),
      },
    });
    await client.query('COMMIT');
    return presentCheck({
      check_id: checkId,
      business_date: businessDate,
      checked_at: checkedAt.toISOString(),
      checker_name: checker.fullLegalName,
      checker_employee_id: checker.employeeId,
      checker_role: checker.role,
      custodians_present: present,
      books: lines.map((line) => ({
        book_class: line.book.book_class,
        book_id: Number(line.book.book_id),
        status: line.book.status,
        matched: line.matched,
        system_totals: line.system,
        counted_totals: line.counted,
        narration_text: line.narration,
      })),
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
}

function presentCheck(row) {
  return {
    check_id: Number(row.check_id),
    business_date: row.business_date,
    checked_at: row.checked_at,
    checked_at_display: formatStamp(row.checked_at),
    checker_name: row.checker_name,
    checker_employee_id: row.checker_employee_id,
    checker_role: row.checker_role,
    custodians_present: row.custodians_present,
    books: row.books,
  };
}

async function listSurpriseChecks(db, tenantId, branchId, date) {
  const result = await db.query(
    `SELECT check_id, business_date::text AS business_date, checked_at,
            checker_name, checker_employee_id, checker_role, custodians_present
     FROM surprise_checks
     WHERE tenant_id = $1 AND branch_id = $2
       AND (
         business_date = $3::date
         OR (checked_at AT TIME ZONE 'Africa/Lusaka')::date = $3::date
       )
     ORDER BY checked_at, check_id`,
    [tenantId, branchId, date],
  );
  const checks = [];
  for (const row of result.rows) {
    const books = await db.query(
      `SELECT book_class, book_id, matched, system_totals, counted_totals, narration_text
       FROM surprise_check_books
       WHERE check_id = $1`,
      [row.check_id],
    );
    const ordered = BOOK_ORDER.map((bookClass) => {
      const line = books.rows.find((item) => item.book_class === bookClass);
      return line ? {
        book_class: line.book_class,
        book_id: Number(line.book_id),
        matched: line.matched,
        system_totals: line.system_totals,
        counted_totals: line.counted_totals,
        narration_text: line.narration_text,
      } : null;
    }).filter(Boolean);
    checks.push(presentCheck({ ...row, books: ordered }));
  }
  return checks;
}

async function surpriseSlip(db, tenantId, checkId) {
  const result = await db.query(
    `SELECT c.check_id, c.branch_id, c.business_date::text AS business_date, c.checked_at,
            c.checker_name, c.checker_employee_id, c.checker_role, c.custodians_present,
            br.branch_name, br.branch_code, t.bank_name, t.logo_label, t.logo_file
     FROM surprise_checks c
     JOIN branches br ON br.branch_id = c.branch_id AND br.tenant_id = c.tenant_id
     JOIN bank_tenants t ON t.tenant_id = c.tenant_id
     WHERE c.check_id = $1 AND c.tenant_id = $2`,
    [checkId, tenantId],
  );
  if (result.rowCount !== 1) {
    throw new VaultError('CHECK_NOT_FOUND', 'That surprise cash check is not on this bank', 404);
  }
  const checks = await listSurpriseChecks(
    db,
    tenantId,
    result.rows[0].branch_id,
    result.rows[0].business_date,
  );
  const match = checks.find((item) => item.check_id === Number(checkId));
  return {
    logo_label: result.rows[0].logo_label || result.rows[0].bank_name,
    logo_file: result.rows[0].logo_file,
    bank_name: result.rows[0].bank_name,
    branch_name: result.rows[0].branch_name,
    branch_code: result.rows[0].branch_code,
    branch_id: Number(result.rows[0].branch_id),
    ...match,
  };
}

async function printSurpriseSlip(db, tenantId, checkId, deps = {}) {
  const slip = await surpriseSlip(db, tenantId, checkId);
  const pdf = await renderSurpriseSlip({ slip, logoFile: slip.logo_file });
  return deliver(db, {
    tenantId,
    branchId: slip.branch_id,
    documentKind: 'SURPRISE_SLIP',
    sourceRef: slip.check_id,
    pdf,
    deps,
  });
}

module.exports = {
  canConductSurprise,
  resolveCheckBranch,
  recordSurpriseCheck,
  listSurpriseChecks,
  surpriseSlip,
  printSurpriseSlip,
};
