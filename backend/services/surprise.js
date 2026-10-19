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

function assertCheckAdmin(user) {
  if (!user || user.actorUserId || !isMasterAdmin({ work_email: user.email })) {
    throw new VaultError(
      'WRONG_ROLE',
      'Only the master admin can archive or delete a surprise cash check',
      403,
    );
  }
}

function assertAssigner(user) {
  if (!user || user.role !== 'BRANCH_ADMINISTRATOR') {
    throw new VaultError(
      'WRONG_ROLE',
      'A branch administrator assigns the surprise cash check',
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
  return figuresFromMinors(book.book_class, minors, { kwachaCode: true });
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
  return figuresFromMinors(bookClass, minors, { kwachaCode: true });
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

async function assignedChecker(db, tenantId, branchId, businessDate, userId) {
  const result = await db.query(
    `SELECT assignee_user_id
     FROM surprise_assignments
     WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3::date`,
    [tenantId, branchId, businessDate],
  );
  return result.rowCount === 1 && Number(result.rows[0].assignee_user_id) === Number(userId);
}

async function recordSurpriseCheck(db, user, body) {
  const branchId = await resolveCheckBranch(db, user);
  const checkedAtPreview = body.checked_at ? new Date(body.checked_at) : new Date();
  const businessDatePreview = body.business_date || (
    Number.isNaN(checkedAtPreview.getTime()) ? '' : lusakaDate(checkedAtPreview)
  );
  if (!canConductSurprise(user)) {
    const assigned = /^\d{4}-\d{2}-\d{2}$/.test(businessDatePreview)
      && await assignedChecker(db, user.tenantId, branchId, businessDatePreview, user.userId);
    if (!assigned) assertCanConduct(user);
  }
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
    const differences = compareFigures(system, counted, { kwachaCode: true });
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
    archived: Boolean(row.archived_at),
    books: row.books,
  };
}

async function listSurpriseChecks(db, tenantId, branchId, date, options = {}) {
  const archived = Boolean(options.archived);
  const result = await db.query(
    `SELECT check_id, business_date::text AS business_date, checked_at,
            checker_name, checker_employee_id, checker_role, custodians_present,
            archived_at
     FROM surprise_checks
     WHERE tenant_id = $1 AND branch_id = $2
       AND (
         business_date = $3::date
         OR (checked_at AT TIME ZONE 'Africa/Lusaka')::date = $3::date
       )
       AND (
         $5::boolean = true
         OR ($4::boolean = true AND archived_at IS NOT NULL)
         OR ($4::boolean = false AND archived_at IS NULL)
       )
     ORDER BY checked_at, check_id`,
    [tenantId, branchId, date, archived, Boolean(options.any)],
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
    { any: true },
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

async function setSurpriseArchived(db, user, checkId, archived) {
  assertCheckAdmin(user);
  const result = await db.query(
    `UPDATE surprise_checks
     SET archived_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
     WHERE check_id = $1 AND tenant_id = $2
     RETURNING check_id, archived_at`,
    [checkId, user.tenantId, Boolean(archived)],
  );
  if (result.rowCount !== 1) {
    throw new VaultError('CHECK_NOT_FOUND', 'That surprise cash check is not on this bank', 404);
  }
  return {
    check_id: Number(result.rows[0].check_id),
    archived: Boolean(result.rows[0].archived_at),
  };
}

async function deleteSurpriseCheck(db, user, checkId) {
  assertCheckAdmin(user);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT check_id FROM surprise_checks WHERE check_id = $1 AND tenant_id = $2`,
      [checkId, user.tenantId],
    );
    if (found.rowCount !== 1) {
      throw new VaultError('CHECK_NOT_FOUND', 'That surprise cash check is not on this bank', 404);
    }
    await client.query(`DELETE FROM surprise_check_books WHERE check_id = $1`, [checkId]);
    await client.query(
      `DELETE FROM surprise_checks WHERE check_id = $1 AND tenant_id = $2`,
      [checkId, user.tenantId],
    );
    await client.query('COMMIT');
    return { deleted: true, check_id: Number(checkId) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
}

async function dutyUserIds(db, tenantId, branchId, businessDate) {
  const ids = new Set();
  for (const postCode of ['CUSTODIAN_ONE', 'CUSTODIAN_TWO']) {
    const row = await assignmentCovering(db, tenantId, branchId, postCode, businessDate);
    if (row) ids.add(Number(row.user_id));
  }
  return ids;
}

function presentAssignment(row) {
  if (!row) return null;
  return {
    user_id: Number(row.user_id),
    full_legal_name: row.full_legal_name,
    employee_id: row.employee_id,
    system_role: row.system_role,
    business_date: row.business_date,
  };
}

async function loadAssignment(db, tenantId, branchId, businessDate) {
  const result = await db.query(
    `SELECT a.business_date::text AS business_date, u.user_id, u.full_legal_name,
            u.employee_id, u.system_role
     FROM surprise_assignments a
     JOIN nodevault_users u ON u.user_id = a.assignee_user_id AND u.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.branch_id = $2 AND a.business_date = $3::date`,
    [tenantId, branchId, businessDate],
  );
  return presentAssignment(result.rows[0]);
}

async function surpriseAssignmentView(db, user, businessDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '')) {
    throw new VaultError('WRONG_DATE', 'Choose the date open on the desk');
  }
  let branchId = user.branchId ? Number(user.branchId) : null;
  if (user.role === 'AUDITOR') {
    try {
      branchId = await resolveCheckBranch(db, user);
    } catch (_error) {
      branchId = user.branchId ? Number(user.branchId) : null;
    }
  }
  if (!branchId) {
    return {
      business_date: businessDate,
      assignment: null,
      can_assign: false,
      can_record: canConductSurprise(user),
      candidates: [],
    };
  }
  const assignment = await loadAssignment(db, user.tenantId, branchId, businessDate);
  const duty = await dutyUserIds(db, user.tenantId, branchId, businessDate);
  const people = await db.query(
    `SELECT user_id, full_legal_name, employee_id, system_role
     FROM nodevault_users
     WHERE tenant_id = $1 AND branch_id = $2 AND is_active = true
       AND system_role <> 'IT_SUPER_ADMIN'
     ORDER BY full_legal_name, employee_id`,
    [user.tenantId, branchId],
  );
  const candidates = people.rows
    .filter((row) => !duty.has(Number(row.user_id)))
    .map((row) => ({
      user_id: Number(row.user_id),
      full_legal_name: row.full_legal_name,
      employee_id: row.employee_id,
      system_role: row.system_role,
    }));
  const isAssignee = assignment && Number(assignment.user_id) === Number(user.userId);
  return {
    business_date: businessDate,
    branch_id: branchId,
    assignment,
    can_assign: user.role === 'BRANCH_ADMINISTRATOR',
    can_record: canConductSurprise(user) || Boolean(isAssignee),
    candidates: user.role === 'BRANCH_ADMINISTRATOR' ? candidates : [],
  };
}

async function assignSurpriseChecker(db, user, body) {
  assertAssigner(user);
  if (!user.branchId) {
    throw new VaultError('NO_BRANCH', 'This profile is not attached to a branch', 409);
  }
  const businessDate = body.business_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '')) {
    throw new VaultError('WRONG_DATE', 'Choose the date open on the desk');
  }
  const assigneeId = Number(body.user_id);
  if (!Number.isInteger(assigneeId)) {
    throw new VaultError('NOT_FOUND', 'Choose the person who will count the cash', 404);
  }
  const person = await db.query(
    `SELECT user_id, branch_id, system_role, is_active
     FROM nodevault_users
     WHERE user_id = $1 AND tenant_id = $2`,
    [assigneeId, user.tenantId],
  );
  if (person.rowCount !== 1 || !person.rows[0].is_active) {
    throw new VaultError('NOT_FOUND', 'Choose the person who will count the cash', 404);
  }
  if (person.rows[0].system_role === 'IT_SUPER_ADMIN') {
    throw new VaultError('WRONG_ROLE', 'The IT super admin cannot be assigned', 403);
  }
  if (Number(person.rows[0].branch_id) !== Number(user.branchId)) {
    throw new VaultError('WRONG_BRANCH', 'Assign someone at this branch', 403);
  }
  const duty = await dutyUserIds(db, user.tenantId, user.branchId, businessDate);
  if (duty.has(assigneeId)) {
    throw new VaultError('WRONG_ROLE', 'A custodian on duty cannot be assigned', 403);
  }
  await db.query(
    `INSERT INTO surprise_assignments (
       tenant_id, branch_id, business_date, assignee_user_id, assigned_by_user_id
     ) VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (tenant_id, branch_id, business_date)
     DO UPDATE SET assignee_user_id = EXCLUDED.assignee_user_id,
                   assigned_by_user_id = EXCLUDED.assigned_by_user_id,
                   created_at = now()`,
    [user.tenantId, user.branchId, businessDate, assigneeId, user.userId],
  );
  return loadAssignment(db, user.tenantId, user.branchId, businessDate);
}

async function withdrawSurpriseAssignment(db, user, businessDate) {
  assertAssigner(user);
  if (!user.branchId) {
    throw new VaultError('NO_BRANCH', 'This profile is not attached to a branch', 409);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '')) {
    throw new VaultError('WRONG_DATE', 'Choose the date open on the desk');
  }
  await db.query(
    `DELETE FROM surprise_assignments
     WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3::date`,
    [user.tenantId, user.branchId, businessDate],
  );
  return { business_date: businessDate, assignment: null };
}

module.exports = {
  canConductSurprise,
  resolveCheckBranch,
  recordSurpriseCheck,
  listSurpriseChecks,
  surpriseSlip,
  printSurpriseSlip,
  setSurpriseArchived,
  deleteSurpriseCheck,
  surpriseAssignmentView,
  assignSurpriseChecker,
  withdrawSurpriseAssignment,
};
