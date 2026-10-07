const { insertLedgerRow, loadRows, positionByCurrency } = require('./ledger');

const BOOK_ORDER = ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY'];

async function createBookWithRows(db, {
  tenantId,
  branchId,
  bookClass,
  businessDate,
  rows,
  mirrorCore = true,
}) {
  const inserted = await db.query(
    `INSERT INTO branch_vault_books (branch_id, tenant_id, book_class, business_date)
     VALUES ($1, $2, $3, $4)
     RETURNING book_id`,
    [branchId, tenantId, bookClass, businessDate],
  );
  const bookId = inserted.rows[0].book_id;
  for (const entry of rows) {
    await insertLedgerRow(db, {
      tenantId,
      bookId,
      transactionDate: entry.transactionDate,
      custodianOneInitials: entry.custodianOneInitials,
      custodianTwoInitials: entry.custodianTwoInitials,
      tellerCoordInitials: entry.tellerCoordInitials,
      accountingLabel: entry.accountingLabel,
      flowDirection: entry.flowDirection,
      amounts: entry.amounts,
    });
  }
  if (mirrorCore) {
    const loaded = await loadRows(db, bookId);
    const closing = [...loaded].reverse().find((row) => row.accountingLabel === 'Bal c/d');
    const position = positionByCurrency(bookClass, closing.cells);
    for (const [currency, minor] of Object.entries(position)) {
      await db.query(
        `INSERT INTO mock_core_positions
           (tenant_id, branch_id, book_id, currency_code, amount_minor)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, branchId, bookId, currency, minor.toString()],
      );
    }
  }
  return bookId;
}

async function listBooks(db, tenantId, businessDate = null) {
  const params = [tenantId];
  let dateClause = '';
  if (businessDate) {
    params.push(businessDate);
    dateClause = ` AND b.business_date = $${params.length}`;
  }
  const result = await db.query(
    `SELECT b.book_id, b.book_class, b.status, b.business_date::text AS business_date,
            b.branch_id, br.branch_name
     FROM branch_vault_books b
     JOIN branches br ON br.branch_id = b.branch_id AND br.tenant_id = b.tenant_id
     WHERE b.tenant_id = $1${dateClause}
     ORDER BY b.business_date DESC,
       CASE b.book_class
         WHEN 'KWACHA_TREASURY' THEN 1
         WHEN 'FOREIGN_CURRENCY' THEN 2
         WHEN 'BANCS_TREASURY' THEN 3
       END`,
    params,
  );
  return result.rows;
}

async function listBookDates(db, tenantId, branchId) {
  const result = await db.query(
    `SELECT business_date::text AS business_date,
            CASE
              WHEN bool_and(status = 'OPEN') THEN 'OPEN'
              WHEN bool_and(status = 'BALANCED_CLOSED') THEN 'BALANCED_CLOSED'
              ELSE 'MIXED'
            END AS status
     FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2
     GROUP BY business_date
     ORDER BY business_date DESC`,
    [tenantId, branchId],
  );
  return result.rows;
}

module.exports = { BOOK_ORDER, createBookWithRows, listBooks, listBookDates };
