const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

let pinHash;

test.before(async () => {
  await setupPools();
  pinHash = await bcrypt.hash('135790', 6);
});

test.after(async () => {
  await closePools();
});

test('ledger rows are append-only, closed books reject lines, and old currency is not a column', async () => {
  await resetDatabase();
  const desk = await createDesk(pinHash);
  const { adminPool, applicationPool } = pools();
  const bookId = desk.books.KWACHA_TREASURY;

  await assert.rejects(
    () => adminPool.query(
      `UPDATE vault_denomination_matrix_ledger SET accounting_label = 'tamper' WHERE book_id = $1`,
      [bookId],
    ),
    /append-only/i,
  );
  await assert.rejects(
    () => adminPool.query(
      `DELETE FROM ledger_amount_cells WHERE matrix_tx_id IN (
         SELECT matrix_tx_id FROM vault_denomination_matrix_ledger WHERE book_id = $1
       )`,
      [bookId],
    ),
    /append-only/i,
  );
  await assert.rejects(
    () => applicationPool.query(
      `UPDATE ledger_amount_cells SET amount_minor = 1
       WHERE matrix_tx_id IN (
         SELECT matrix_tx_id FROM vault_denomination_matrix_ledger WHERE book_id = $1
       )`,
      [bookId],
    ),
    /permission denied/i,
  );
  await assert.rejects(
    () => applicationPool.query('TRUNCATE vault_denomination_matrix_ledger'),
    /permission denied/i,
  );
  await assert.rejects(
    () => adminPool.query('DELETE FROM branch_vault_books WHERE book_id = $1', [bookId]),
    /cannot be deleted/i,
  );

  const entry = await applicationPool.query(
    'SELECT matrix_tx_id FROM vault_denomination_matrix_ledger WHERE book_id = $1 ORDER BY line_number LIMIT 1',
    [bookId],
  );
  await assert.rejects(
    () => adminPool.query(
      `INSERT INTO ledger_amount_cells
         (matrix_tx_id, channel_code, denomination_code, cell_kind, amount_minor)
       VALUES ($1, 'OLD_CURRENCY', 'B', 'DENOMINATION', 100)`,
      [entry.rows[0].matrix_tx_id],
    ),
    /not in the denomination catalogue/i,
  );

  await applicationPool.query(
    `UPDATE branch_vault_books
     SET status = 'BALANCED_CLOSED', closed_at = now()
     WHERE book_id = $1`,
    [bookId],
  );
  await assert.rejects(
    () => applicationPool.query(
      `INSERT INTO vault_denomination_matrix_ledger (
         book_id, line_number, transaction_date,
         custodian_one_initials, custodian_two_initials, teller_coord_initials,
         accounting_label, flow_direction
       ) VALUES ($1, 99, '2026-10-03', 'C.A.', 'J.P.', 'M.K.', 'LATE', 'IN')`,
      [bookId],
    ),
    /closed books reject new rows/i,
  );

  const classes = await applicationPool.query(
    `SELECT book_class FROM branch_vault_books WHERE branch_id = $1 ORDER BY book_class`,
    [desk.branchId],
  );
  assert.deepEqual(classes.rows.map((row) => row.book_class), [
    'BANCS_TREASURY',
    'FOREIGN_CURRENCY',
    'KWACHA_TREASURY',
  ]);
  await assert.rejects(
    () => applicationPool.query(
      `INSERT INTO branch_vault_books (branch_id, tenant_id, book_class, business_date)
       VALUES ($1, $2, 'KWACHA_TREASURY', '2026-10-03')`,
      [desk.branchId, desk.tenantId],
    ),
    /duplicate key/i,
  );
});
