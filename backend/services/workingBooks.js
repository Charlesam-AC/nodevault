const { BOOK_ORDER } = require('./books');
const { optionsForBranch } = require('./closures');
const { upcomingBusinessDate } = require('./calendar');
const { recordAudit } = require('./audit');
const {
  loadRows,
  amountsFromCells,
  insertLedgerRow,
  positionByCurrency,
} = require('./ledger');

async function sourceDate(db, tenantId, branchId, workingDate) {
  const result = await db.query(
    `SELECT business_date::text AS business_date
     FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND business_date < $3::date
     GROUP BY business_date
     HAVING COUNT(*) = 3 AND bool_and(status = 'BALANCED_CLOSED')
     ORDER BY business_date DESC
     LIMIT 1`,
    [tenantId, branchId, workingDate],
  );
  return result.rows[0] ? result.rows[0].business_date : null;
}

async function openOne(db, {
  tenantId,
  branchId,
  bookClass,
  workingDate,
  priorBusinessDate,
}) {
  const existing = await db.query(
    `SELECT book_id FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND book_class = $3 AND business_date = $4`,
    [tenantId, branchId, bookClass, workingDate],
  );
  if (existing.rowCount === 1) {
    return { bookClass, status: 'ALREADY', bookId: Number(existing.rows[0].book_id) };
  }
  const prior = await db.query(
    `SELECT book_id FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND book_class = $3
       AND business_date = $4 AND status = 'BALANCED_CLOSED'`,
    [tenantId, branchId, bookClass, priorBusinessDate],
  );
  if (prior.rowCount !== 1) return { bookClass, status: 'MISSING' };
  const priorRows = await loadRows(db, prior.rows[0].book_id);
  const carried = [...priorRows].reverse().find((row) => row.flowDirection === 'BAL' && row.accountingLabel === 'Bal c/d');
  if (!carried) return { bookClass, status: 'NO_CARRIED_DOWN' };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO branch_vault_books (branch_id, tenant_id, book_class, business_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, branch_id, book_class, business_date) DO NOTHING
       RETURNING book_id`,
      [branchId, tenantId, bookClass, workingDate],
    );
    if (inserted.rowCount !== 1) {
      await client.query('COMMIT');
      return { bookClass, status: 'ALREADY' };
    }
    const bookId = inserted.rows[0].book_id;
    await insertLedgerRow(client, {
      tenantId,
      bookId,
      transactionDate: workingDate,
      custodianOneInitials: carried.custodianOneInitials,
      custodianTwoInitials: carried.custodianTwoInitials,
      tellerCoordInitials: carried.tellerCoordInitials,
      accountingLabel: 'Bal b/f',
      flowDirection: 'BAL',
      amounts: amountsFromCells(carried.cells),
    }, { manageTransaction: false });
    const opened = (await loadRows(client, bookId)).find((row) => row.accountingLabel === 'Bal b/f');
    const position = positionByCurrency(bookClass, opened.cells);
    for (const [currency, minor] of Object.entries(position)) {
      await client.query(
        `INSERT INTO mock_core_positions
           (tenant_id, branch_id, book_id, currency_code, amount_minor)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, branch_id, book_id, currency_code) DO NOTHING`,
        [tenantId, branchId, bookId, currency, minor.toString()],
      );
    }
    await recordAudit(client, {
      tenantId,
      bookId,
      eventType: 'WORKING_BOOK_OPENED',
      detail: { bookClass, workingDate, priorBusinessDate },
    });
    await client.query('COMMIT');
    return { bookClass, status: 'POSTED', bookId: Number(bookId) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    if (error.code === '23505') return { bookClass, status: 'ALREADY' };
    throw error;
  } finally {
    client.release();
  }
}

async function ensureWorkingBooks(db, now = new Date()) {
  if (process.env.SEED_DEMO_DATA !== 'true') return { ensured: false, results: [] };
  const branches = await db.query('SELECT tenant_id, branch_id FROM branches');
  const results = [];
  for (const branch of branches.rows) {
    const tenantId = Number(branch.tenant_id);
    const branchId = Number(branch.branch_id);
    const options = await optionsForBranch(db, tenantId, branchId, { now });
    const workingDate = upcomingBusinessDate(now, options);
    const priorBusinessDate = await sourceDate(db, tenantId, branchId, workingDate);
    if (!priorBusinessDate) {
      results.push({ branchId, workingDate, skipped: 'NO_CLOSED_SOURCE' });
      continue;
    }
    const opened = [];
    for (const bookClass of BOOK_ORDER) {
      opened.push(await openOne(db, {
        tenantId, branchId, bookClass, workingDate, priorBusinessDate,
      }));
    }
    results.push({ branchId, workingDate, priorBusinessDate, opened });
  }
  return { ensured: true, results };
}

module.exports = { ensureWorkingBooks };
