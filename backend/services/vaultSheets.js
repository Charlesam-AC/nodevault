const bcrypt = require('bcryptjs');
const { VaultError } = require('./errors');
const { isMasterAdmin } = require('../middleware/auth');
const { holdersForDate } = require('./rotation');
const { insertLedgerRow } = require('./ledger');
const { assertMovementOption } = require('./movements');
const { toMinor } = require('./money');
const { formatStamp } = require('./narration');
const { BOOK_ORDER } = require('./books');
const { printColumns, bookTotalMinor, denomRows, renderVaultSheet } = require('./documents');
const { deliver } = require('./printJobs');
const { recordAudit } = require('./audit');

function assertCanSheet(user) {
  if (!user) throw new VaultError('WRONG_ROLE', 'This desk cannot write a vault sheet', 403);
  if (user.role === 'VAULT_CUSTODIAN' || user.role === 'HEAD_TELLER_COORDINATOR') return;
  if (user.role === 'IT_SUPER_ADMIN' && user.breakGlassId) return;
  if (isMasterAdmin({ work_email: user.email }) && !user.actorUserId) return;
  throw new VaultError('WRONG_ROLE', 'This desk cannot write a vault sheet', 403);
}

async function pinMatches(pin, hash) {
  if (typeof pin !== 'string' || pin.length < 4 || pin.length > 32 || !hash) return false;
  return bcrypt.compare(pin, hash);
}

function typedMinor(bookClass, amounts) {
  let total = 0n;
  for (const column of printColumns(bookClass)) {
    if (column.kind !== 'DENOMINATION') continue;
    const raw = amounts && amounts[column.channel] ? amounts[column.channel][column.code] : undefined;
    if (raw != null && String(raw).trim() !== '') total += toMinor(String(raw));
  }
  if (bookClass !== 'KWACHA_TREASURY') {
    const raw = amounts && amounts.USD ? amounts.USD['2'] : undefined;
    if (raw != null && String(raw).trim() !== '') total += toMinor(String(raw));
  }
  return total;
}

async function verifyTrio(client, tenantId, branchId, body, operatingDate) {
  const ids = [Number(body.c1_id), Number(body.c2_id), Number(body.coord_id)];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== 3) {
    throw new VaultError('INVALID_SIGNATORY', 'The vault sheet needs the two custodians and the head teller');
  }
  const users = await client.query(
    `SELECT user_id, closing_pin_hash, system_role, full_legal_name, employee_id, two_letter_initials
     FROM nodevault_users
     WHERE user_id = ANY($1::int[]) AND tenant_id = $2 AND is_active = true`,
    [ids, tenantId],
  );
  if (users.rowCount !== 3) throw new VaultError('SIGNATORY_MISSING', 'Security exception: active profiles missing for this tenant', 403);
  const byId = new Map(users.rows.map((user) => [Number(user.user_id), user]));
  const c1 = byId.get(ids[0]);
  const c2 = byId.get(ids[1]);
  const coord = byId.get(ids[2]);
  if (c1.system_role !== 'VAULT_CUSTODIAN' || c2.system_role !== 'VAULT_CUSTODIAN') {
    throw new VaultError('WRONG_ROLE', 'Both custodians must be active vault custodians', 403);
  }
  if (coord.system_role !== 'HEAD_TELLER_COORDINATOR') {
    throw new VaultError('WRONG_ROLE', 'The third signatory must be the head teller', 403);
  }
  const roster = await holdersForDate(client, tenantId, branchId, operatingDate);
  if (!roster.open) {
    throw new VaultError('HANDOVER_REQUIRED', 'The desk is shut until the incoming custodians and head teller are handed over', 409);
  }
  const assigned = new Set([
    Number(roster.holders.CUSTODIAN_ONE.user_id),
    Number(roster.holders.CUSTODIAN_TWO.user_id),
  ]);
  if (!assigned.has(ids[0]) || !assigned.has(ids[1]) || Number(roster.holders.HEAD_TELLER.user_id) !== ids[2]) {
    throw new VaultError('CUSTODIAN_NOT_ASSIGNED', 'Those signatories are not the roster for this date', 403);
  }
  const pinsOk = await Promise.all([
    pinMatches(body.c1_pin, c1.closing_pin_hash),
    pinMatches(body.c2_pin, c2.closing_pin_hash),
    pinMatches(body.coord_pin, coord.closing_pin_hash),
  ]);
  if (pinsOk.some((ok) => !ok)) throw new VaultError('WRONG_PIN', 'Access denied: auth failure', 401);
  return [
    { ...c1, role: 'Custodian 1' },
    { ...c2, role: 'Custodian 2' },
    { ...coord, role: 'Head teller' },
  ].map((person) => ({
    role: person.role,
    full_legal_name: person.full_legal_name,
    employee_id: person.employee_id,
    initials: person.two_letter_initials,
  }));
}

async function loadSheet(db, tenantId, sheetId) {
  const result = await db.query(
    `SELECT s.sheet_id, s.branch_id, s.direction, s.business_date::text AS business_date,
            s.generated_at, s.amounts, s.signatories, s.line_ids, s.printed_at,
            b.branch_name, t.bank_name, t.logo_file
     FROM vault_sheets s
     JOIN branches b ON b.branch_id = s.branch_id AND b.tenant_id = s.tenant_id
     JOIN bank_tenants t ON t.tenant_id = s.tenant_id
     WHERE s.sheet_id = $1 AND s.tenant_id = $2`,
    [sheetId, tenantId],
  );
  if (!result.rowCount) throw new VaultError('NOT_FOUND', 'That vault sheet is not on this bank', 404);
  const row = result.rows[0];
  return {
    sheet_id: Number(row.sheet_id),
    branch_id: Number(row.branch_id),
    direction: row.direction,
    business_date: row.business_date,
    generated_at: row.generated_at,
    generated_at_display: formatStamp(row.generated_at),
    amounts: row.amounts,
    signatories: row.signatories,
    line_ids: row.line_ids || {},
    printed_at: row.printed_at,
    branch_name: row.branch_name,
    bank_name: row.bank_name,
    logo_file: row.logo_file,
  };
}

async function printSheet(db, tenantId, sheet, deps) {
  const pdf = await renderVaultSheet({ sheet, logoFile: sheet.logo_file });
  const result = await deliver(db, {
    tenantId,
    branchId: sheet.branch_id,
    documentKind: 'VAULT_SHEET',
    sourceRef: sheet.sheet_id,
    pdf,
    deps,
  });
  if (result.status === 'SENT') {
    await db.query(
      `UPDATE vault_sheets SET printed_at = now() WHERE sheet_id = $1 AND tenant_id = $2`,
      [sheet.sheet_id, tenantId],
    );
  }
  return result;
}

async function createVaultSheet(db, user, branchId, body, deps = {}) {
  assertCanSheet(user);
  if (!user.branchId || Number(user.branchId) !== Number(branchId)) {
    throw new VaultError('WRONG_BRANCH', 'A vault sheet is written on the branch this desk is signed into', 403);
  }
  if (body.direction !== 'FROM_VAULT' && body.direction !== 'TO_VAULT') {
    throw new VaultError('INVALID_DIRECTION', 'Choose From Vault or To Vault');
  }
  const operatingDate = body.operating_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(operatingDate || '')) {
    throw new VaultError('WRONG_DATE', 'operating_date must be YYYY-MM-DD');
  }
  const amounts = body.books && typeof body.books === 'object' ? body.books : {};
  const label = body.direction === 'FROM_VAULT' ? 'Out' : 'In';
  const flow = body.direction === 'FROM_VAULT' ? 'OUT' : 'IN';
  const client = await db.connect();
  let sheetId;
  try {
    await client.query('BEGIN');
    const signatories = await verifyTrio(client, user.tenantId, branchId, body, operatingDate);
    const books = await client.query(
      `SELECT book_id, book_class, status
       FROM branch_vault_books
       WHERE tenant_id = $1 AND branch_id = $2 AND business_date = $3
       FOR UPDATE`,
      [user.tenantId, branchId, operatingDate],
    );
    if (books.rowCount !== 3) {
      throw new VaultError('NO_BOOK', `There is no full set of books for ${operatingDate}`, 409);
    }
    const byClass = new Map(books.rows.map((row) => [row.book_class, row]));
    for (const bookClass of BOOK_ORDER) {
      const book = byClass.get(bookClass);
      if (!book) throw new VaultError('NO_BOOK', `There is no full set of books for ${operatingDate}`, 409);
      if (typedMinor(bookClass, amounts[bookClass]) > 0n && book.status !== 'OPEN') {
        throw new VaultError('BOOK_CLOSED', 'A closed book cannot take a vault movement', 409);
      }
    }
    const inserted = await client.query(
      `INSERT INTO vault_sheets (
         tenant_id, branch_id, direction, business_date, amounts, signatories, created_by
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
       RETURNING sheet_id`,
      [user.tenantId, branchId, body.direction, operatingDate, JSON.stringify(amounts), JSON.stringify(signatories), user.userId],
    );
    sheetId = Number(inserted.rows[0].sheet_id);
    const lineIds = {};
    const people = signatories;
    for (const bookClass of BOOK_ORDER) {
      const typed = amounts[bookClass] || {};
      if (typedMinor(bookClass, typed) === 0n) {
        lineIds[bookClass] = null;
        continue;
      }
      await assertMovementOption(client, user.tenantId, label, flow);
      const book = byClass.get(bookClass);
      const created = await insertLedgerRow(client, {
        tenantId: user.tenantId,
        bookId: book.book_id,
        transactionDate: operatingDate,
        custodianOneInitials: people[0].initials,
        custodianTwoInitials: people[1].initials,
        tellerCoordInitials: people[2].initials,
        accountingLabel: label,
        lineReference: `VS-${sheetId}`,
        flowDirection: flow,
        amounts: typed,
      }, { manageTransaction: false });
      lineIds[bookClass] = Number(created.matrixTxId);
    }
    await client.query(
      `UPDATE vault_sheets SET line_ids = $1::jsonb WHERE sheet_id = $2`,
      [JSON.stringify(lineIds), sheetId],
    );
    await recordAudit(client, {
      tenantId: user.tenantId,
      eventType: 'VAULT_SHEET_POSTED',
      actorUserIds: [user.userId, ...signatories.map(() => user.userId)].slice(0, 1),
      detail: { sheet_id: sheetId, direction: body.direction, line_ids: lineIds },
    });
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
  const sheet = await loadSheet(db, user.tenantId, sheetId);
  const print = await printSheet(db, user.tenantId, sheet, deps);
  return { ...sheet, print };
}

async function reprintVaultSheet(db, user, sheetId, deps = {}) {
  assertCanSheet(user);
  const sheet = await loadSheet(db, user.tenantId, sheetId);
  if (Number(sheet.branch_id) !== Number(user.branchId)) {
    throw new VaultError('WRONG_BRANCH', 'A vault sheet is printed on its own branch', 403);
  }
  const print = await printSheet(db, user.tenantId, sheet, deps);
  return { sheet_id: sheet.sheet_id, line_ids: sheet.line_ids, print };
}

module.exports = {
  createVaultSheet,
  reprintVaultSheet,
  loadSheet,
  typedMinor,
  denomRows,
  bookTotalMinor,
};
