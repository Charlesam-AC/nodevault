const { VaultError } = require('./errors');
const { isMasterAdmin } = require('../middleware/auth');
const { recordAudit } = require('./audit');
const { zonedParts } = require('./calendar');
const { formatDisplayDate } = require('./week');
const { BOOK_ORDER } = require('./books');
const { loadRows, runningPosition, cellsFromMap, positionByCurrency } = require('./ledger');
const { getOutstandingPosition, listCoreTransactions } = require('./corebank');
const { resolveLogo, renderAuditSheet } = require('./documents');
const { deliver } = require('./printJobs');

const CURRENCIES = {
  KWACHA_TREASURY: ['ZMW'],
  FOREIGN_CURRENCY: ['EUR', 'GBP', 'USD', 'ZAR'],
  BANCS_TREASURY: ['EUR', 'GBP', 'USD', 'ZAR'],
};
const BOOK_TITLE = {
  KWACHA_TREASURY: 'Kwacha Treasury Book',
  FOREIGN_CURRENCY: 'Foreign Currency Treasury Book',
  BANCS_TREASURY: 'Bancs Treasury Book',
};
const MARKS = new Set(['REVIEWED', 'MATCHED', 'UNMATCHED', 'MATCHED_WITH_DIFFERENCE']);
const CORE_KINDS = new Set(['CIT_SLIP', 'ATM', 'TELLER']);

function assertAuditor(user) {
  if (!user || user.role !== 'AUDITOR') {
    throw new VaultError('WRONG_ROLE', 'Only an auditor works the audit review', 403);
  }
  if (String(user.email || '').toLowerCase() === 'demo@nodevault.local') {
    throw new VaultError('WRONG_ROLE', 'The demo setup account cannot sign off an audit', 403);
  }
}

function assertMaster(actor) {
  if (!actor || !isMasterAdmin({ work_email: actor.email }) || actor.actorUserId) {
    throw new VaultError('WRONG_ROLE', 'Only the master admin assigns auditor branches', 403);
  }
}

function assertRange(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) {
    throw new VaultError('INVALID_RANGE', 'The audit range is two dates, from then to');
  }
}

async function assertAssigned(db, user, branchId) {
  const assigned = await db.query(
    `SELECT 1 FROM auditor_branches
     WHERE tenant_id = $1 AND user_id = $2 AND branch_id = $3`,
    [user.tenantId, user.userId, branchId],
  );
  if (!assigned.rowCount) {
    throw new VaultError('AUDIT_BRANCH', 'That branch is not assigned to this auditor', 403);
  }
}

async function currentBranchId(db, user) {
  const result = await db.query(
    `SELECT current_audit_branch_id FROM nodevault_users WHERE user_id = $1 AND tenant_id = $2`,
    [user.userId, user.tenantId],
  );
  if (!result.rowCount) throw new VaultError('NOT_FOUND', 'That auditor is not on this bank', 404);
  return result.rows[0].current_audit_branch_id;
}

async function branchGate(db, tenantId, userId, branchId) {
  const pending = await db.query(
    `SELECT pending_final_comment_at FROM auditor_branches
     WHERE tenant_id = $1 AND user_id = $2 AND branch_id = $3`,
    [tenantId, userId, branchId],
  );
  const lines = await db.query(
    `SELECT l.matrix_tx_id, b.business_date::text AS business_date
     FROM vault_denomination_matrix_ledger l
     JOIN branch_vault_books b ON b.book_id = l.book_id
     WHERE b.tenant_id = $1 AND b.branch_id = $2`,
    [tenantId, branchId],
  );
  const signoffs = await db.query(
    `SELECT range_from::text AS range_from, range_to::text AS range_to
     FROM audit_signoffs WHERE tenant_id = $1 AND branch_id = $2`,
    [tenantId, branchId],
  );
  const marks = await db.query(
    `SELECT matrix_tx_id FROM audit_line_marks WHERE tenant_id = $1 AND branch_id = $2`,
    [tenantId, branchId],
  );
  const marked = new Set(marks.rows.map((row) => String(row.matrix_tx_id)));
  const covered = (date) => signoffs.rows.some((row) => date >= row.range_from && date <= row.range_to);
  const reviewed = signoffs.rowCount > 0 && lines.rows.every((line) => (
    covered(line.business_date) && marked.has(String(line.matrix_tx_id))
  ));
  return {
    pending: Boolean(pending.rows[0] && pending.rows[0].pending_final_comment_at),
    reviewed,
  };
}

async function assignAuditorBranches(db, actor, userId, branchIds) {
  assertMaster(actor);
  const person = await db.query(
    `SELECT user_id, system_role, current_audit_branch_id
     FROM nodevault_users
     WHERE user_id = $1 AND tenant_id = $2 AND is_active = true`,
    [userId, actor.tenantId],
  );
  if (!person.rowCount || person.rows[0].system_role !== 'AUDITOR') {
    throw new VaultError('WRONG_ROLE', 'Assign branches to an auditor', 409);
  }
  const ids = [...new Set((branchIds || []).map((value) => Number(value)))];
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new VaultError('INVALID_BRANCH', 'Choose at least one branch');
  }
  const found = await db.query(
    `SELECT branch_id FROM branches WHERE tenant_id = $1 AND branch_id = ANY($2::int[])`,
    [actor.tenantId, ids],
  );
  if (found.rowCount !== ids.length) {
    throw new VaultError('NOT_FOUND', 'That branch is not on this bank', 404);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM auditor_branches WHERE tenant_id = $1 AND user_id = $2`,
      [actor.tenantId, userId],
    );
    for (const branchId of ids) {
      await client.query(
        `INSERT INTO auditor_branches (tenant_id, user_id, branch_id) VALUES ($1,$2,$3)`,
        [actor.tenantId, userId, branchId],
      );
    }
    const current = person.rows[0].current_audit_branch_id;
    if (current && !ids.includes(Number(current))) {
      await client.query(
        `UPDATE nodevault_users SET current_audit_branch_id = NULL
         WHERE user_id = $1 AND tenant_id = $2`,
        [userId, actor.tenantId],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
  return { user_id: Number(userId), branch_ids: ids };
}

async function listAuditorBranches(db, actor, userId) {
  assertMaster(actor);
  const rows = await db.query(
    `SELECT branch_id FROM auditor_branches WHERE tenant_id = $1 AND user_id = $2 ORDER BY branch_id`,
    [actor.tenantId, userId],
  );
  return { user_id: Number(userId), branch_ids: rows.rows.map((row) => Number(row.branch_id)) };
}

async function listAssignments(db, user) {
  assertAuditor(user);
  const branches = await db.query(
    `SELECT b.branch_id, b.branch_name, b.branch_code, a.pending_final_comment_at
     FROM auditor_branches a
     JOIN branches b ON b.branch_id = a.branch_id AND b.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.user_id = $2
     ORDER BY b.branch_name`,
    [user.tenantId, user.userId],
  );
  const current = await currentBranchId(db, user);
  return {
    current_audit_branch_id: current == null ? null : Number(current),
    branches: branches.rows.map((row) => ({
      branch_id: Number(row.branch_id),
      branch_name: row.branch_name,
      branch_code: row.branch_code,
      pending_final_comment: Boolean(row.pending_final_comment_at),
    })),
  };
}

async function setCurrentBranch(db, user, branchId) {
  assertAuditor(user);
  const id = Number(branchId);
  if (!Number.isInteger(id) || id <= 0) throw new VaultError('INVALID_BRANCH', 'Choose a branch');
  await assertAssigned(db, user, id);
  const current = await currentBranchId(db, user);
  if (current && Number(current) !== id) {
    const gate = await branchGate(db, user.tenantId, user.userId, current);
    if (!gate.reviewed && !gate.pending) {
      throw new VaultError(
        'AUDIT_OPEN',
        'Mark the current branch reviewed or pending final comment before leaving it',
        409,
      );
    }
  }
  await db.query(
    `UPDATE nodevault_users SET current_audit_branch_id = $1 WHERE user_id = $2 AND tenant_id = $3`,
    [id, user.userId, user.tenantId],
  );
  return { current_audit_branch_id: id };
}

async function assertCurrent(db, user, branchId) {
  assertAuditor(user);
  const id = Number(branchId);
  await assertAssigned(db, user, id);
  const current = await currentBranchId(db, user);
  if (!current) throw new VaultError('AUDIT_BRANCH', 'Select the branch you are auditing', 409);
  if (Number(current) !== id) {
    throw new VaultError('AUDIT_BRANCH', 'An auditor works one branch at a time', 409);
  }
}

async function markPending(db, user, branchId) {
  await assertCurrent(db, user, branchId);
  await db.query(
    `UPDATE auditor_branches SET pending_final_comment_at = now()
     WHERE tenant_id = $1 AND user_id = $2 AND branch_id = $3`,
    [user.tenantId, user.userId, branchId],
  );
  return { branch_id: Number(branchId), pending_final_comment: true };
}

async function markLine(db, user, branchId, matrixTxId, body) {
  await assertCurrent(db, user, branchId);
  const id = Number(matrixTxId);
  if (!Number.isInteger(id) || id <= 0) throw new VaultError('LINE_NOT_FOUND', 'That line is not on this branch', 404);
  const status = body.status || body.mark_status;
  if (!MARKS.has(status)) throw new VaultError('INVALID_MARK', 'Mark the line reviewed, matched, unmatched, or matched with a difference');
  const comment = body.comment == null ? '' : String(body.comment);
  if (comment.length > 2000) throw new VaultError('INVALID_MARK', 'A line comment is at most 2000 characters');
  let kind = body.core_ref_kind == null || body.core_ref_kind === '' ? null : String(body.core_ref_kind);
  if (kind && !CORE_KINDS.has(kind)) throw new VaultError('INVALID_MARK', 'A core reference is a CIT slip, an ATM transaction, or a teller entry');
  const line = await db.query(
    `SELECT l.matrix_tx_id
     FROM vault_denomination_matrix_ledger l
     JOIN branch_vault_books b ON b.book_id = l.book_id
     WHERE l.matrix_tx_id = $1 AND b.tenant_id = $2 AND b.branch_id = $3`,
    [id, user.tenantId, branchId],
  );
  if (!line.rowCount) throw new VaultError('LINE_NOT_FOUND', 'That line is not on this branch', 404);
  const existing = await db.query(
    `SELECT mark_id FROM audit_line_marks WHERE matrix_tx_id = $1`,
    [id],
  );
  try {
    if (existing.rowCount) {
      await db.query(
        `UPDATE audit_line_marks
         SET mark_status = $1, comment = $2, core_ref_kind = $3, marked_by = $4, marked_at = now()
         WHERE matrix_tx_id = $5`,
        [status, comment, kind, user.userId, id],
      );
    } else {
      await db.query(
        `INSERT INTO audit_line_marks (
           tenant_id, branch_id, matrix_tx_id, mark_status, comment, core_ref_kind, marked_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [user.tenantId, branchId, id, status, comment, kind, user.userId],
      );
    }
  } catch (error) {
    if (/frozen after sign-off/i.test(String(error.message || ''))) {
      throw new VaultError('MARK_FROZEN', 'That line is frozen after sign-off', 409);
    }
    throw error;
  }
  return { matrix_tx_id: id, mark_status: status, comment, core_ref_kind: kind };
}

async function latestBook(db, tenantId, branchId, bookClass, from, to) {
  const result = await db.query(
    `SELECT book_id, business_date::text AS business_date, status, closed_at
     FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND book_class = $3
       AND business_date BETWEEN $4::date AND $5::date
     ORDER BY business_date DESC
     LIMIT 1`,
    [tenantId, branchId, bookClass, from, to],
  );
  return result.rows[0] || null;
}

async function buildReview(db, tenantId, branchId, from, to) {
  assertRange(from, to);
  const branch = await db.query(
    `SELECT b.branch_name, t.bank_name, t.logo_file
     FROM branches b
     JOIN bank_tenants t ON t.tenant_id = b.tenant_id
     WHERE b.tenant_id = $1 AND b.branch_id = $2`,
    [tenantId, branchId],
  );
  if (!branch.rowCount) throw new VaultError('NOT_FOUND', 'That branch is not on this bank', 404);
  const linesResult = await db.query(
    `SELECT l.matrix_tx_id, l.line_number, l.transaction_date::text AS transaction_date,
            l.accounting_label, l.line_reference, l.flow_direction,
            b.book_class, b.business_date::text AS business_date, b.book_id,
            m.mark_status, m.comment, m.core_ref_kind
     FROM vault_denomination_matrix_ledger l
     JOIN branch_vault_books b ON b.book_id = l.book_id
     LEFT JOIN audit_line_marks m ON m.matrix_tx_id = l.matrix_tx_id
     WHERE b.tenant_id = $1 AND b.branch_id = $2
       AND b.business_date BETWEEN $3::date AND $4::date
     ORDER BY b.business_date, b.book_class, l.line_number`,
    [tenantId, branchId, from, to],
  );
  const lines = linesResult.rows.map((row) => ({
    matrix_tx_id: Number(row.matrix_tx_id),
    book_id: Number(row.book_id),
    book_class: row.book_class,
    book_title: BOOK_TITLE[row.book_class],
    line_number: row.line_number,
    business_date: row.business_date,
    date_display: formatDisplayDate(row.business_date),
    accounting_label: row.accounting_label,
    line_reference: row.line_reference,
    flow_direction: row.flow_direction,
    mark_status: row.mark_status,
    comment: row.comment || '',
    core_ref_kind: row.core_ref_kind,
  }));
  const surprise = await db.query(
    `SELECT c.check_id, c.business_date::text AS business_date, c.checked_at,
            c.checker_name, c.checker_employee_id, c.checker_role
     FROM surprise_checks c
     WHERE c.tenant_id = $1 AND c.branch_id = $2
       AND (c.checked_at AT TIME ZONE 'Africa/Lusaka')::date BETWEEN $3::date AND $4::date
     ORDER BY c.checked_at, c.check_id`,
    [tenantId, branchId, from, to],
  );
  const surpriseChecks = [];
  for (const row of surprise.rows) {
    const books = await db.query(
      `SELECT book_class, counted_totals, system_totals, matched, narration_text
       FROM surprise_check_books WHERE check_id = $1`,
      [row.check_id],
    );
    surpriseChecks.push({
      check_id: Number(row.check_id),
      business_date: row.business_date,
      checked_at: row.checked_at,
      checked_on: zonedParts(new Date(row.checked_at), 'Africa/Lusaka').isoDate,
      checker_name: row.checker_name,
      checker_employee_id: row.checker_employee_id,
      checker_role: row.checker_role,
      books: books.rows,
    });
  }
  const latestCheck = surpriseChecks[surpriseChecks.length - 1] || null;
  const totals = [];
  for (const bookClass of BOOK_ORDER) {
    const book = await latestBook(db, tenantId, branchId, bookClass, from, to);
    let position = {};
    let core = {};
    if (book) {
      const rows = await loadRows(db, book.book_id);
      position = positionByCurrency(bookClass, cellsFromMap(bookClass, runningPosition(rows)));
      core = await getOutstandingPosition(db, { tenantId, branchId, bookId: book.book_id });
    }
    const counted = latestCheck
      ? (latestCheck.books.find((item) => item.book_class === bookClass) || {}).counted_totals || []
      : [];
    for (const currency of CURRENCIES[bookClass]) {
      const physical = counted.find((item) => item.currency === currency);
      totals.push({
        book_class: bookClass,
        book_title: BOOK_TITLE[bookClass],
        currency,
        physical_minor: physical ? String(physical.minor) : null,
        book_minor: position[currency] == null ? null : position[currency].toString(),
        core_minor: core[currency] == null ? null : core[currency].toString(),
      });
    }
  }
  const narrations = await db.query(
    `SELECT narration_id, book_class, business_date::text AS business_date, narration_text, handover_id
     FROM book_narrations
     WHERE tenant_id = $1 AND branch_id = $2 AND business_date BETWEEN $3::date AND $4::date
     ORDER BY business_date, book_class`,
    [tenantId, branchId, from, to],
  );
  const closes = await db.query(
    `SELECT book_id, book_class, business_date::text AS business_date, closed_at
     FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND status = 'BALANCED_CLOSED'
       AND business_date BETWEEN $3::date AND $4::date
     ORDER BY business_date, book_class`,
    [tenantId, branchId, from, to],
  );
  const coreWithoutBook = [];
  for (const bookClass of BOOK_ORDER) {
    const transactions = await listCoreTransactions(db, { tenantId, branchId, bookClass, from, to });
    const refs = new Set(
      lines.filter((line) => line.book_class === bookClass && line.line_reference)
        .map((line) => line.line_reference),
    );
    for (const tx of transactions) {
      if (!refs.has(tx.reference)) coreWithoutBook.push(tx);
    }
  }
  return {
    bank_name: branch.rows[0].bank_name,
    branch_name: branch.rows[0].branch_name,
    logo_file: branch.rows[0].logo_file,
    branch_id: Number(branchId),
    range_from: from,
    range_to: to,
    range_from_display: formatDisplayDate(from),
    range_to_display: formatDisplayDate(to),
    lines,
    totals,
    narrations: narrations.rows,
    closes: closes.rows.map((row) => ({
      book_id: Number(row.book_id),
      book_class: row.book_class,
      business_date: row.business_date,
      closed_at: row.closed_at,
    })),
    surprise_checks: surpriseChecks,
    commented_lines: lines.filter((line) => String(line.comment || '').trim()),
    core_without_book: coreWithoutBook,
    reviewed_without_comment: lines.filter((line) => line.mark_status && !String(line.comment || '').trim()).length,
  };
}

async function getReview(db, user, branchId, from, to) {
  await assertCurrent(db, user, branchId);
  return buildReview(db, user.tenantId, branchId, from, to);
}

async function printSignoffSheet(db, tenantId, signoff, deps) {
  const review = await buildReview(db, tenantId, signoff.branch_id, signoff.range_from, signoff.range_to);
  review.end_comment = signoff.end_comment;
  review.auditor = {
    full_legal_name: signoff.full_legal_name,
    employee_id: signoff.employee_id,
  };
  const pdf = await renderAuditSheet({ review, logoFile: review.logo_file });
  return deliver(db, {
    tenantId,
    branchId: signoff.branch_id,
    documentKind: 'AUDIT_SHEET',
    sourceRef: signoff.signoff_id,
    pdf,
    deps,
  });
}

async function signOff(db, user, branchId, body, deps = {}) {
  await assertCurrent(db, user, branchId);
  assertRange(body.from, body.to);
  const comment = String(body.comment || body.end_comment || '').trim();
  if (!comment) throw new VaultError('SIGN_OFF_INCOMPLETE', 'The end-of-audit comment is required');
  const identity = await db.query(
    `SELECT full_legal_name, employee_id, work_email, system_role
     FROM nodevault_users WHERE user_id = $1 AND tenant_id = $2 AND is_active = true`,
    [user.userId, user.tenantId],
  );
  if (!identity.rowCount) throw new VaultError('NOT_FOUND', 'That auditor is not on this bank', 404);
  const person = identity.rows[0];
  if (person.work_email === 'demo@nodevault.local') {
    throw new VaultError('WRONG_ROLE', 'The demo setup account cannot sign off an audit', 403);
  }
  const unmarked = await db.query(
    `SELECT l.matrix_tx_id
     FROM vault_denomination_matrix_ledger l
     JOIN branch_vault_books b ON b.book_id = l.book_id
     WHERE b.tenant_id = $1 AND b.branch_id = $2
       AND b.business_date BETWEEN $3::date AND $4::date
       AND NOT EXISTS (
         SELECT 1 FROM audit_line_marks m WHERE m.matrix_tx_id = l.matrix_tx_id
       )`,
    [user.tenantId, branchId, body.from, body.to],
  );
  if (unmarked.rowCount) {
    throw new VaultError('SIGN_OFF_INCOMPLETE', 'Every ledger line in the range has to be marked before sign-off', 409);
  }
  const client = await db.connect();
  let signoff;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO audit_signoffs (
         tenant_id, branch_id, auditor_user_id, range_from, range_to, end_comment,
         full_legal_name, employee_id, work_email, system_role
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING signoff_id, signed_at`,
      [
        user.tenantId, branchId, user.userId, body.from, body.to, comment,
        person.full_legal_name, person.employee_id, person.work_email, person.system_role,
      ],
    );
    await client.query(
      `UPDATE auditor_branches SET pending_final_comment_at = NULL
       WHERE tenant_id = $1 AND user_id = $2 AND branch_id = $3`,
      [user.tenantId, user.userId, branchId],
    );
    await recordAudit(client, {
      tenantId: user.tenantId,
      eventType: 'AUDIT_SIGNED_OFF',
      actorUserIds: [user.userId],
      detail: {
        signoff_id: Number(inserted.rows[0].signoff_id),
        branch_id: Number(branchId),
        from: body.from,
        to: body.to,
      },
    });
    await client.query('COMMIT');
    signoff = {
      signoff_id: Number(inserted.rows[0].signoff_id),
      signed_at: inserted.rows[0].signed_at,
      branch_id: Number(branchId),
      range_from: body.from,
      range_to: body.to,
      end_comment: comment,
      full_legal_name: person.full_legal_name,
      employee_id: person.employee_id,
      work_email: person.work_email,
      system_role: person.system_role,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
  const print = await printSignoffSheet(db, user.tenantId, signoff, deps);
  return { ...signoff, print };
}

async function reprintSignoff(db, user, signoffId, deps = {}) {
  assertAuditor(user);
  const result = await db.query(
    `SELECT signoff_id, branch_id, range_from::text AS range_from, range_to::text AS range_to,
            end_comment, full_legal_name, employee_id
     FROM audit_signoffs WHERE signoff_id = $1 AND tenant_id = $2`,
    [signoffId, user.tenantId],
  );
  if (!result.rowCount) throw new VaultError('NOT_FOUND', 'That audit sheet is not on this bank', 404);
  const signoff = result.rows[0];
  await assertAssigned(db, user, signoff.branch_id);
  signoff.signoff_id = Number(signoff.signoff_id);
  signoff.branch_id = Number(signoff.branch_id);
  return printSignoffSheet(db, user.tenantId, signoff, deps);
}

module.exports = {
  assertAuditor,
  assignAuditorBranches,
  listAuditorBranches,
  listAssignments,
  setCurrentBranch,
  markPending,
  markLine,
  buildReview,
  getReview,
  signOff,
  reprintSignoff,
  branchGate,
};
