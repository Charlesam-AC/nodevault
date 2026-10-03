const { BOOK_ORDER } = require('./books');
const { recordAudit } = require('./audit');
const { loadRows, amountsFromCells, insertLedgerRow, positionByCurrency } = require('./ledger');
const { holdersForDate } = require('./rotation');
const {
  calendarOptions,
  businessMorning,
  previousBusinessDay,
} = require('./calendar');

const TITLES = {
  KWACHA_TREASURY: 'Kwacha Treasury Book',
  FOREIGN_CURRENCY: 'Foreign Currency Treasury Book',
  BANCS_TREASURY: 'Bancs Treasury Book',
};

async function flagBlocked(db, {
  tenantId,
  branchId,
  bookClass,
  businessDate,
  priorBusinessDate,
  reason,
}) {
  const inserted = await db.query(
    `INSERT INTO carry_forward_flags
       (tenant_id, branch_id, book_class, business_date, prior_business_date, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, branch_id, book_class, business_date) DO NOTHING
     RETURNING flag_id`,
    [tenantId, branchId, bookClass, businessDate, priorBusinessDate, reason],
  );
  if (inserted.rowCount === 1) {
    await recordAudit(db, {
      tenantId,
      eventType: 'CARRY_FORWARD_BLOCKED',
      detail: { bookClass, businessDate, priorBusinessDate, reason },
    });
  }
  return { bookClass, status: 'FLAGGED', reason, businessDate, priorBusinessDate };
}

async function carryOne(db, {
  tenantId,
  branchId,
  bookClass,
  businessDate,
  priorBusinessDate,
}) {
  const prior = await db.query(
    `SELECT book_id, status
     FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND book_class = $3 AND business_date = $4`,
    [tenantId, branchId, bookClass, priorBusinessDate],
  );
  if (prior.rowCount !== 1) {
    return flagBlocked(db, {
      tenantId, branchId, bookClass, businessDate, priorBusinessDate, reason: 'MISSING',
    });
  }
  if (prior.rows[0].status !== 'BALANCED_CLOSED') {
    return flagBlocked(db, {
      tenantId, branchId, bookClass, businessDate, priorBusinessDate, reason: 'NOT_CLOSED',
    });
  }
  const priorRows = await loadRows(db, prior.rows[0].book_id);
  const carried = [...priorRows].reverse().find((row) => row.flowDirection === 'BAL' && row.accountingLabel === 'Bal c/d');
  if (!carried || priorRows[priorRows.length - 1] !== carried) {
    return flagBlocked(db, {
      tenantId, branchId, bookClass, businessDate, priorBusinessDate, reason: 'NO_CARRIED_DOWN',
    });
  }

  const existing = await db.query(
    `SELECT book_id FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND book_class = $3 AND business_date = $4`,
    [tenantId, branchId, bookClass, businessDate],
  );
  if (existing.rowCount === 1) {
    const lines = await db.query(
      `SELECT accounting_label FROM vault_denomination_matrix_ledger
       WHERE book_id = $1 ORDER BY line_number`,
      [existing.rows[0].book_id],
    );
    if (lines.rowCount > 0 && lines.rows[0].accounting_label === 'Bal b/f') {
      return { bookClass, status: 'ALREADY', bookId: Number(existing.rows[0].book_id) };
    }
    if (lines.rowCount > 0) {
      return { bookClass, status: 'ALREADY', bookId: Number(existing.rows[0].book_id) };
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let bookId = existing.rowCount === 1 ? existing.rows[0].book_id : null;
    if (!bookId) {
      const inserted = await client.query(
        `INSERT INTO branch_vault_books (branch_id, tenant_id, book_class, business_date)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, branch_id, book_class, business_date) DO NOTHING
         RETURNING book_id`,
        [branchId, tenantId, bookClass, businessDate],
      );
      if (inserted.rowCount !== 1) {
        await client.query('COMMIT');
        return { bookClass, status: 'ALREADY' };
      }
      bookId = inserted.rows[0].book_id;
    }
    const amounts = amountsFromCells(carried.cells);
    await insertLedgerRow(client, {
      tenantId,
      bookId,
      transactionDate: businessDate,
      custodianOneInitials: carried.custodianOneInitials,
      custodianTwoInitials: carried.custodianTwoInitials,
      tellerCoordInitials: carried.tellerCoordInitials,
      accountingLabel: 'Bal b/f',
      flowDirection: 'BAL',
      amounts,
    }, { manageTransaction: false });
    const position = positionByCurrency(bookClass, (await loadRows(client, bookId)).find((row) => row.accountingLabel === 'Bal b/f').cells);
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
      eventType: 'BALANCE_BROUGHT_FORWARD',
      detail: {
        bookClass,
        businessDate,
        priorBusinessDate,
        priorBookId: Number(prior.rows[0].book_id),
        amounts,
      },
    });
    await client.query('COMMIT');
    return { bookClass, status: 'POSTED', bookId: Number(bookId), title: TITLES[bookClass] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    if (error.code === '23505') {
      return { bookClass, status: 'ALREADY' };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function carryForwardBranch(db, tenantId, branchId, now = new Date(), overrides = {}) {
  const options = calendarOptions(overrides);
  const businessDate = businessMorning(now, options);
  if (!businessDate) {
    return { businessDate: null, results: [], skipped: 'NOT_A_BUSINESS_MORNING' };
  }
  const gate = await holdersForDate(db, tenantId, branchId, businessDate);
  if (!gate.open) {
    return { businessDate, results: [], skipped: 'HANDOVER_REQUIRED', missing: gate.missing };
  }
  const priorBusinessDate = previousBusinessDay(businessDate, options.holidays);
  const results = [];
  for (const bookClass of BOOK_ORDER) {
    results.push(await carryOne(db, {
      tenantId, branchId, bookClass, businessDate, priorBusinessDate,
    }));
  }
  return { businessDate, priorBusinessDate, results };
}

async function listCarryFlags(db, tenantId, branchId, businessDate) {
  const result = await db.query(
    `SELECT f.book_class, f.business_date::text AS business_date,
            f.prior_business_date::text AS prior_business_date, f.reason
     FROM carry_forward_flags f
     WHERE f.tenant_id = $1 AND f.branch_id = $2 AND f.business_date = $3
       AND NOT EXISTS (
         SELECT 1 FROM branch_vault_books b
         WHERE b.tenant_id = f.tenant_id AND b.branch_id = f.branch_id
           AND b.book_class = f.book_class AND b.business_date = f.business_date
       )
     ORDER BY f.book_class`,
    [tenantId, branchId, businessDate],
  );
  return result.rows;
}

module.exports = {
  carryForwardBranch,
  listCarryFlags,
  TITLES,
};
