const bcrypt = require('bcryptjs');
const { VaultError } = require('./errors');
const { formatDisplayDate } = require('./week');
const { holdersForDate } = require('./rotation');
const { mapsEqual, toDecimalString, formatMoney } = require('./money');
const { getLayout } = require('./layout');
const { loadRows, rollForward, positionByCurrency, parsePosition } = require('./ledger');
const { getOutstandingPosition } = require('./corebank');
const { triggerSilentPrinter } = require('./print');
const { sendClosingSheet } = require('./mail');
const { recordAudit } = require('./audit');

const SYMBOL = { ZMW: 'K', ZAR: 'R', USD: '$', GBP: '£', EUR: '€' };

function sheetMoney(minor, currency) {
  return formatMoney(minor, SYMBOL[currency] || '');
}

async function pinMatches(pin, hash) {
  if (typeof pin !== 'string' || pin.length < 4 || pin.length > 32 || !hash) return false;
  return bcrypt.compare(pin, hash);
}

function buildSheet({ layout, operatingDate, branchName, position, signatories }) {
  const lines = [
    'NODEVAULT CLOSING SHEET',
    layout.title,
    `${branchName}    ${formatDisplayDate(operatingDate)}`,
    layout.formula,
    '',
    'Certified position',
  ];
  for (const [currency, minor] of Object.entries(position)) {
    lines.push(`  ${currency}  ${sheetMoney(minor, currency)}`);
  }
  lines.push('', 'Triple sign-off');
  for (const person of signatories) {
    lines.push(`  ${person.role}: ${person.full_legal_name}  ${person.employee_id}  ${person.two_letter_initials}`);
  }
  lines.push('', 'Zero variance against the core banking position. The book is now locked.');
  return lines.join('\n');
}

async function lockBook(client, tenantId, branchId, closingPayload, deps) {
  const {
    c1_id: c1Id,
    c1_pin: c1Pin,
    c2_id: c2Id,
    c2_pin: c2Pin,
    coord_id: coordId,
    coord_pin: coordPin,
    target_book_id: bookId,
    calculated_matrix_cash_total: declaredTotal,
    operating_date: operatingDate,
  } = closingPayload;

  const ids = [Number(c1Id), Number(c2Id), Number(coordId)];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new VaultError('INVALID_SIGNATORY', 'Three signatory ids are required');
  }
  if (new Set(ids).size !== 3) {
    throw new VaultError('DUPLICATE_SIGNATORY', 'Closing requires three distinct people', 400);
  }

  const users = await client.query(
    `SELECT user_id, closing_pin_hash, system_role, full_legal_name, work_email,
            employee_id, two_letter_initials
     FROM nodevault_users
     WHERE user_id = ANY($1::int[]) AND tenant_id = $2 AND is_active = true`,
    [ids, tenantId],
  );
  if (users.rowCount !== 3) {
    throw new VaultError('SIGNATORY_MISSING', 'Security exception: active profiles missing for this tenant', 403);
  }
  const byId = new Map(users.rows.map((user) => [Number(user.user_id), user]));
  const c1 = byId.get(ids[0]);
  const c2 = byId.get(ids[1]);
  const coord = byId.get(ids[2]);

  if (c1.system_role !== 'VAULT_CUSTODIAN' || c2.system_role !== 'VAULT_CUSTODIAN') {
    throw new VaultError('WRONG_ROLE', 'Both custodians must be active vault custodians', 403);
  }
  if (coord.system_role !== 'HEAD_TELLER_COORDINATOR') {
    throw new VaultError('WRONG_ROLE', 'The third signatory must be the head teller coordinator', 403);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(operatingDate || '')) {
    throw new VaultError('WRONG_DATE', 'operating_date must be YYYY-MM-DD');
  }
  const roster = await holdersForDate(client, tenantId, branchId, operatingDate);
  if (!roster.open) {
    throw new VaultError(
      'HANDOVER_REQUIRED',
      'The desk is shut until the incoming custodians and head teller are handed over',
      409,
    );
  }
  if (Number(roster.holders.HEAD_TELLER.user_id) !== ids[2]) {
    throw new VaultError(
      'COORDINATOR_NOT_ASSIGNED',
      'That coordinator is not assigned to this branch for the operating date',
      403,
    );
  }
  const assignedCustodians = new Set([
    Number(roster.holders.CUSTODIAN_ONE.user_id),
    Number(roster.holders.CUSTODIAN_TWO.user_id),
  ]);
  if (!assignedCustodians.has(ids[0]) || !assignedCustodians.has(ids[1])) {
    throw new VaultError(
      'CUSTODIAN_NOT_ASSIGNED',
      'That custodian is not assigned to this branch for the operating date',
      403,
    );
  }

  const pinsOk = await Promise.all([
    pinMatches(c1Pin, c1.closing_pin_hash),
    pinMatches(c2Pin, c2.closing_pin_hash),
    pinMatches(coordPin, coord.closing_pin_hash),
  ]);
  if (pinsOk.some((ok) => !ok)) {
    throw new VaultError('WRONG_PIN', 'Access denied: auth failure', 401);
  }

  const bookResult = await client.query(
    `SELECT b.book_id, b.book_class, b.status, b.business_date::text AS business_date, br.branch_name
     FROM branch_vault_books b
     JOIN branches br ON br.branch_id = b.branch_id AND br.tenant_id = b.tenant_id
     WHERE b.book_id = $1 AND b.tenant_id = $2 AND b.branch_id = $3
     FOR UPDATE OF b`,
    [bookId, tenantId, branchId],
  );
  if (bookResult.rowCount !== 1) {
    throw new VaultError('BOOK_NOT_FOUND', 'Treasury book not found for this branch', 404);
  }
  const book = bookResult.rows[0];
  if (book.status !== 'OPEN') {
    throw new VaultError('BOOK_CLOSED', 'This book is already closed', 409);
  }
  if (book.business_date !== operatingDate) {
    throw new VaultError('WRONG_DATE', 'The operating date does not match the book', 409);
  }

  const rows = await loadRows(client, book.book_id);
  rollForward(rows);
  const carried = [...rows].reverse().find((row) => row.flowDirection === 'BAL' && row.accountingLabel === 'Bal c/d');
  if (!carried || rows[rows.length - 1] !== carried) {
    throw new VaultError('BOOK_OUT_OF_BALANCE', 'Close requires a final Bal c/d row', 409);
  }
  const ledgerPosition = positionByCurrency(book.book_class, carried.cells);
  const declared = parsePosition(declaredTotal);
  if (!mapsEqual(ledgerPosition, declared)) {
    throw new VaultError('VARIANCE', 'Variance exception: the certified total does not match the book', 409);
  }

  const getOutstanding = deps.getOutstanding || getOutstandingPosition;
  const corePosition = await getOutstanding(client, {
    tenantId,
    branchId,
    bookId: book.book_id,
  });
  if (!mapsEqual(ledgerPosition, corePosition)) {
    throw new VaultError(
      'VARIANCE',
      'Variance exception: close refused because the book does not match the core banking position',
      409,
    );
  }

  await client.query(
    `UPDATE branch_vault_books
     SET status = 'BALANCED_CLOSED', closed_at = now()
     WHERE book_id = $1 AND tenant_id = $2`,
    [book.book_id, tenantId],
  );

  const roms = await client.query(
    `SELECT work_email FROM nodevault_users
     WHERE tenant_id = $1 AND system_role = 'REGIONAL_OPS_MANAGER' AND is_active = true
     ORDER BY user_id`,
    [tenantId],
  );
  const cc = [...new Set([
    ...roms.rows.map((row) => row.work_email),
    process.env.ROM_EMAIL || '',
  ].filter(Boolean))];

  const layout = getLayout(book.book_class);
  const document = buildSheet({
    layout,
    operatingDate,
    branchName: book.branch_name,
    position: ledgerPosition,
    signatories: [
      { ...c1, role: 'Primary custodian' },
      { ...c2, role: 'Secondary custodian' },
      { ...coord, role: 'Weekly teller coordinator' },
    ],
  });
  const totals = Object.fromEntries(
    Object.entries(ledgerPosition).map(([currency, minor]) => [currency, toDecimalString(minor)]),
  );

  await recordAudit(client, {
    tenantId,
    eventType: 'BOOK_CLOSED',
    bookId: book.book_id,
    actorUserIds: ids,
    detail: {
      operating_date: operatingDate,
      book_class: book.book_class,
      totals,
      signatories: [c1, c2, coord].map((person) => ({
        user_id: person.user_id,
        full_legal_name: person.full_legal_name,
        employee_id: person.employee_id,
        initials: person.two_letter_initials,
        role: person.system_role,
      })),
    },
  });

  const printPayload = {
    branchId,
    bookId: Number(book.book_id),
    printerTarget: process.env.PRINTER_TARGET || 'Vault_Master_Printer_01',
    document,
  };
  const emailPayload = {
    to: [c1.work_email, c2.work_email],
    cc,
    subject: `NodeVault closing sheet · ${layout.title} · ${formatDisplayDate(operatingDate)}`,
    text: document,
  };
  await client.query(
    `INSERT INTO dispatch_outbox (tenant_id, book_id, kind, payload)
     VALUES ($1, $2, 'PRINT', $3::jsonb), ($1, $2, 'EMAIL', $4::jsonb)`,
    [tenantId, book.book_id, JSON.stringify(printPayload), JSON.stringify(emailPayload)],
  );

  return { tenantId, bookId: book.book_id };
}

async function dispatchClosing(pool, scope, deps = {}) {
  const pending = await pool.query(
    `SELECT dispatch_id, kind, payload
     FROM dispatch_outbox
     WHERE tenant_id = $1 AND book_id = $2 AND status IN ('PENDING', 'FAILED') AND attempts < 5
     ORDER BY dispatch_id`,
    [scope.tenantId, scope.bookId],
  );
  const results = [];
  for (const job of pending.rows) {
    try {
      if (job.kind === 'PRINT') {
        const printer = deps.printer || triggerSilentPrinter;
        await printer(job.payload);
      } else if (job.kind === 'EMAIL') {
        const mailer = deps.mailer || sendClosingSheet;
        await mailer(job.payload);
      } else {
        throw new Error(`Unknown dispatch kind ${job.kind}`);
      }
      await pool.query(
        `UPDATE dispatch_outbox
         SET status = 'SENT', attempts = attempts + 1, last_error = NULL, updated_at = now()
         WHERE dispatch_id = $1`,
        [job.dispatch_id],
      );
      results.push({ id: Number(job.dispatch_id), kind: job.kind, status: 'SENT' });
    } catch (error) {
      await pool.query(
        `UPDATE dispatch_outbox
         SET status = 'FAILED', attempts = attempts + 1, last_error = $2, updated_at = now()
         WHERE dispatch_id = $1`,
        [job.dispatch_id, String(error.message || error).slice(0, 500)],
      );
      await recordAudit(pool, {
        tenantId: scope.tenantId,
        eventType: 'DISPATCH_FAILED',
        bookId: scope.bookId,
        actorUserIds: [],
        detail: { kind: job.kind, error: String(error.message || error).slice(0, 500) },
      });
      results.push({
        id: Number(job.dispatch_id),
        kind: job.kind,
        status: 'FAILED',
        error: String(error.message || error),
      });
    }
  }
  return results;
}

// The lock commits before print or email. A dispatch failure cannot reopen the book.
async function executeThreePersonVaultLock(tenantId, branchId, closingPayload, deps = {}) {
  const pool = deps.pool;
  const client = await pool.connect();
  let committed = null;
  try {
    await client.query('BEGIN');
    committed = await lockBook(client, tenantId, branchId, closingPayload, deps);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already closed */ }
    throw error;
  } finally {
    client.release();
  }
  const dispatch = await dispatchClosing(pool, committed, deps);
  return { status: 'SUCCESS', book_id: Number(committed.bookId), dispatch };
}

module.exports = {
  executeThreePersonVaultLock,
  dispatchClosing,
  buildSheet,
};
