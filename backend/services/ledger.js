const { VaultError } = require('./errors');
const { toMinor, toDecimalString, formatMoney } = require('./money');
const { getLayout, publicLayout } = require('./layout');
const { formatDisplayDate } = require('./week');

function cellKey(channel, code, kind) {
  return `${channel}|${code}|${kind}`;
}

function inOrOut(entry) {
  if (entry.accountingLabel === 'CIT In' || entry.accountingLabel === 'CIT Out') {
    return entry.accountingLabel;
  }
  if (entry.flowDirection === 'IN') return 'In';
  if (entry.flowDirection === 'OUT') return 'Out';
  return entry.accountingLabel;
}

function initialsOf(entry) {
  return [
    entry.custodianOneInitials,
    entry.custodianTwoInitials,
    entry.tellerCoordInitials,
  ].join('  ');
}

function composeRow(bookClass, entry) {
  const layout = getLayout(bookClass);
  const provided = entry.amounts || {};
  const knownChannels = new Set(layout.columns.map((column) => column.channel));
  for (const channel of Object.keys(provided)) {
    if (!knownChannels.has(channel)) {
      throw new VaultError('UNKNOWN_CHANNEL', `Unknown amount channel ${channel}`);
    }
  }
  const cells = [];
  const totals = new Map();
  for (const column of layout.columns) {
    if (column.kind !== 'DENOMINATION') continue;
    const channelAmounts = provided[column.channel] || {};
    if (channelAmounts[column.code] === undefined && Object.prototype.hasOwnProperty.call(channelAmounts, column.code)) {
      throw new VaultError('INVALID_AMOUNT', `Missing amount for ${column.header}`);
    }
    const raw = channelAmounts[column.code] === undefined ? '0.00' : channelAmounts[column.code];
    let minor;
    try {
      minor = toMinor(raw);
    } catch (error) {
      throw new VaultError('INVALID_AMOUNT', error.message);
    }
    totals.set(column.channel, (totals.get(column.channel) || 0n) + minor);
    cells.push({ ...column, amountMinor: minor });
  }
  for (const channel of Object.keys(provided)) {
    const allowed = new Set(
      layout.columns
        .filter((column) => column.channel === channel && column.kind === 'DENOMINATION')
        .map((column) => column.code),
    );
    for (const code of Object.keys(provided[channel])) {
      if (!allowed.has(code)) {
        throw new VaultError('UNKNOWN_DENOMINATION', `Unknown denomination ${channel} ${code}`);
      }
    }
  }
  for (const column of layout.columns) {
    if (column.kind === 'SUBTOTAL') {
      cells.push({ ...column, amountMinor: totals.get(column.channel) || 0n });
    }
  }
  const grand = layout.columns.find((column) => column.kind === 'GRAND');
  if (grand) {
    const grandMinor = layout.columns
      .filter((column) => column.kind === 'SUBTOTAL' && column.inGrand)
      .reduce((sum, column) => sum + (totals.get(column.channel) || 0n), 0n);
    cells.push({ ...grand, amountMinor: grandMinor });
  }
  return cells;
}

function displayFor(cell, flowDirection) {
  const signed = cell.kind !== 'DENOMINATION' && flowDirection !== 'BAL';
  return formatMoney(cell.amountMinor, cell.symbol, { signed });
}

function mapFromCells(cells) {
  const map = {};
  for (const cell of cells) {
    map[cellKey(cell.channel, cell.code, cell.kind)] = cell.amountMinor;
  }
  return map;
}

function cellsFromMap(bookClass, map) {
  const layout = getLayout(bookClass);
  return layout.columns.map((column) => ({
    ...column,
    amountMinor: map[cellKey(column.channel, column.code, column.kind)] || 0n,
  }));
}

function runningPosition(rows) {
  let position = null;
  for (const row of rows) {
    const snapshot = mapFromCells(row.cells);
    if (row.flowDirection === 'BAL') {
      if (position !== null && !sameMap(position, snapshot)) {
        throw new VaultError(
          'BOOK_OUT_OF_BALANCE',
          'A balance row does not match the running denomination position',
          409,
        );
      }
      position = snapshot;
    } else if (row.flowDirection === 'IN' || row.flowDirection === 'OUT') {
      if (position === null) {
        throw new VaultError('BOOK_OUT_OF_BALANCE', 'Movements cannot precede the opening balance', 409);
      }
      const sign = row.flowDirection === 'IN' ? 1n : -1n;
      const next = { ...position };
      const keys = new Set([...Object.keys(position), ...Object.keys(snapshot)]);
      for (const key of keys) {
        const value = (position[key] || 0n) + sign * (snapshot[key] || 0n);
        if (value < 0n) {
          throw new VaultError('BOOK_OUT_OF_BALANCE', 'A denomination would go negative', 409);
        }
        next[key] = value;
      }
      position = next;
    } else {
      throw new VaultError('INVALID_FLOW', 'Flow must be IN, OUT, or BAL');
    }
  }
  if (position === null) {
    throw new VaultError('BOOK_OUT_OF_BALANCE', 'The book has no opening balance', 409);
  }
  return position;
}

function rollForward(rows) {
  const position = runningPosition(rows);
  const lastBalance = [...rows].reverse().find((row) => row.flowDirection === 'BAL');
  if (!lastBalance || !sameMap(position, mapFromCells(lastBalance.cells))) {
    throw new VaultError(
      'BOOK_OUT_OF_BALANCE',
      'The carried-down row is not the current position',
      409,
    );
  }
  return position;
}

function sameMap(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] || 0n) !== (right[key] || 0n)) return false;
  }
  return true;
}

function positionByCurrency(bookClass, cells) {
  const layout = getLayout(bookClass);
  const out = {};
  if (layout.grandCurrency) {
    const grand = cells.find((cell) => cell.kind === 'GRAND');
    out[layout.grandCurrency] = grand.amountMinor;
    return out;
  }
  for (const column of layout.columns) {
    if (column.kind !== 'SUBTOTAL') continue;
    const cell = cells.find((item) => item.channel === column.channel && item.kind === 'SUBTOTAL');
    out[column.currency] = cell.amountMinor;
  }
  return out;
}

function parsePosition(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new VaultError('INVALID_TOTAL', 'calculated_matrix_cash_total must be currency decimal strings');
  }
  const out = {};
  for (const [currency, amount] of Object.entries(payload)) {
    try {
      out[currency] = toMinor(amount);
    } catch (error) {
      throw new VaultError('INVALID_TOTAL', error.message);
    }
  }
  return out;
}

function amountsFromCells(cells) {
  const amounts = {};
  for (const cell of cells) {
    if (cell.kind !== 'DENOMINATION') continue;
    if (!amounts[cell.channel]) amounts[cell.channel] = {};
    amounts[cell.channel][cell.code] = toDecimalString(cell.amountMinor);
  }
  return amounts;
}

async function insertLedgerRow(db, {
  tenantId,
  bookId,
  transactionDate,
  custodianOneInitials,
  custodianTwoInitials,
  tellerCoordInitials,
  accountingLabel,
  flowDirection,
  amounts,
}, { manageTransaction = true } = {}) {
  if (!['IN', 'OUT', 'BAL'].includes(flowDirection)) {
    throw new VaultError('INVALID_FLOW', 'Flow must be IN, OUT, or BAL');
  }
  for (const initials of [custodianOneInitials, custodianTwoInitials, tellerCoordInitials]) {
    if (!initials || String(initials).length > 8) {
      throw new VaultError('INVALID_INITIALS', 'Each signatory initials field is required');
    }
  }
  const client = manageTransaction && typeof db.connect === 'function' && !db.release
    ? await db.connect()
    : db;
  const release = manageTransaction && client !== db;
  try {
    if (manageTransaction) await client.query('BEGIN');
    const book = await client.query(
      `SELECT book_id, book_class, status
       FROM branch_vault_books
       WHERE book_id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [bookId, tenantId],
    );
    if (book.rowCount !== 1) {
      throw new VaultError('BOOK_NOT_FOUND', 'Treasury book not found', 404);
    }
    if (book.rows[0].status !== 'OPEN') {
      throw new VaultError('BOOK_CLOSED', 'Closed books reject new rows', 409);
    }
    const cells = composeRow(book.rows[0].book_class, {
      amounts,
      flowDirection,
      accountingLabel,
      custodianOneInitials,
      custodianTwoInitials,
      tellerCoordInitials,
    });
    const existing = await loadRows(client, bookId);
    runningPosition([...existing, { flowDirection, cells }]);
    const line = await client.query(
      `SELECT COALESCE(MAX(line_number), 0) + 1 AS next_line
       FROM vault_denomination_matrix_ledger
       WHERE book_id = $1`,
      [bookId],
    );
    const inserted = await client.query(
      `INSERT INTO vault_denomination_matrix_ledger (
         book_id, line_number, transaction_date,
         custodian_one_initials, custodian_two_initials, teller_coord_initials,
         accounting_label, flow_direction
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING matrix_tx_id, line_number`,
      [
        bookId,
        line.rows[0].next_line,
        transactionDate,
        custodianOneInitials,
        custodianTwoInitials,
        tellerCoordInitials,
        accountingLabel,
        flowDirection,
      ],
    );
    const entryId = inserted.rows[0].matrix_tx_id;
    const values = [];
    const params = [];
    cells.forEach((cell, index) => {
      const base = index * 5;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      params.push(entryId, cell.channel, cell.code, cell.kind, cell.amountMinor.toString());
    });
    await client.query(
      `INSERT INTO ledger_amount_cells
         (matrix_tx_id, channel_code, denomination_code, cell_kind, amount_minor)
       VALUES ${values.join(',')}`,
      params,
    );
    if (manageTransaction) await client.query('COMMIT');
    return { matrixTxId: entryId, lineNumber: inserted.rows[0].line_number };
  } catch (error) {
    if (manageTransaction) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    }
    throw translateLedgerError(error);
  } finally {
    if (release) client.release();
  }
}

function translateLedgerError(error) {
  if (error instanceof VaultError) return error;
  const text = String(error.message || '');
  if (/append-only|closed books|subtotal|total treasury|catalogue|missing catalogue|not in the denomination/i.test(text)) {
    const detail = text.replace(/^error:\s*/i, '').split('\n')[0];
    return new VaultError('LEDGER_REJECTED', detail, 409);
  }
  return error;
}

async function loadRows(db, bookId) {
  const entries = await db.query(
    `SELECT matrix_tx_id, line_number, transaction_date::text AS transaction_date,
            custodian_one_initials, custodian_two_initials, teller_coord_initials,
            accounting_label, flow_direction
     FROM vault_denomination_matrix_ledger
     WHERE book_id = $1
     ORDER BY line_number`,
    [bookId],
  );
  if (entries.rowCount === 0) return [];
  const ids = entries.rows.map((row) => row.matrix_tx_id);
  const cells = await db.query(
    `SELECT matrix_tx_id, channel_code, denomination_code, cell_kind, amount_minor
     FROM ledger_amount_cells
     WHERE matrix_tx_id = ANY($1::bigint[])`,
    [ids],
  );
  const byEntry = new Map();
  for (const cell of cells.rows) {
    const list = byEntry.get(String(cell.matrix_tx_id)) || [];
    list.push(cell);
    byEntry.set(String(cell.matrix_tx_id), list);
  }
  return entries.rows.map((entry) => ({
    lineNumber: entry.line_number,
    transactionDate: entry.transaction_date,
    custodianOneInitials: entry.custodian_one_initials,
    custodianTwoInitials: entry.custodian_two_initials,
    tellerCoordInitials: entry.teller_coord_initials,
    accountingLabel: entry.accounting_label,
    flowDirection: entry.flow_direction,
    cells: (byEntry.get(String(entry.matrix_tx_id)) || []).map((cell) => ({
      channel: cell.channel_code,
      code: cell.denomination_code,
      kind: cell.cell_kind,
      amountMinor: BigInt(cell.amount_minor),
    })),
  }));
}

function presentRows(bookClass, rows) {
  const layout = getLayout(bookClass);
  return rows.map((row) => {
    const displays = {};
    for (const column of layout.columns) {
      const cell = row.cells.find((item) => (
        item.channel === column.channel && item.code === column.code && item.kind === column.kind
      ));
      const minor = cell ? cell.amountMinor : 0n;
      displays[cellKey(column.channel, column.code, column.kind)] = displayFor(
        { ...column, amountMinor: minor },
        row.flowDirection,
      );
    }
    return {
      line_number: row.lineNumber,
      transaction_date: row.transactionDate,
      date_display: formatDisplayDate(row.transactionDate),
      in_or_out: inOrOut(row),
      initials: initialsOf(row),
      accounting_label: row.accountingLabel,
      flow_direction: row.flowDirection,
      displays,
    };
  });
}

async function getBookView(db, tenantId, bookId) {
  const book = await db.query(
    `SELECT b.book_id, b.book_class, b.status, b.business_date::text AS business_date,
            b.branch_id, br.branch_name, br.branch_code, t.bank_name
     FROM branch_vault_books b
     JOIN branches br ON br.branch_id = b.branch_id AND br.tenant_id = b.tenant_id
     JOIN bank_tenants t ON t.tenant_id = b.tenant_id
     WHERE b.book_id = $1 AND b.tenant_id = $2`,
    [bookId, tenantId],
  );
  if (book.rowCount !== 1) {
    throw new VaultError('BOOK_NOT_FOUND', 'Treasury book not found', 404);
  }
  const record = book.rows[0];
  const rows = await loadRows(db, bookId);
  let position = null;
  let squareRequired = false;
  if (rows.length) {
    try {
      const map = runningPosition(rows);
      const minors = positionByCurrency(record.book_class, cellsFromMap(record.book_class, map));
      position = {};
      for (const [currency, minor] of Object.entries(minors)) {
        const symbol = currency === 'ZMW' ? 'K'
          : currency === 'ZAR' ? 'R'
            : currency === 'USD' ? '$'
              : currency === 'GBP' ? '£'
                : currency === 'EUR' ? '€'
                  : '';
        position[currency] = {
          decimal: toDecimalString(minor),
          display: formatMoney(minor, symbol),
        };
      }
      const last = rows[rows.length - 1];
      const squared = last.flowDirection === 'BAL'
        && last.accountingLabel === 'Bal c/d'
        && sameMap(map, mapFromCells(last.cells));
      squareRequired = !squared;
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      position = { error: error.message };
    }
  }
  return {
    book: record,
    layout: publicLayout(record.book_class),
    rows: presentRows(record.book_class, rows),
    position,
    square_required: squareRequired,
  };
}

async function writeCarriedDown(db, {
  tenantId,
  bookId,
  custodianOneInitials,
  custodianTwoInitials,
  tellerCoordInitials,
}) {
  const owns = typeof db.connect === 'function' && !db.release;
  const client = owns ? await db.connect() : db;
  try {
    if (owns) await client.query('BEGIN');
    const book = await client.query(
      `SELECT book_id, branch_id, book_class, status, business_date::text AS business_date
       FROM branch_vault_books
       WHERE book_id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [bookId, tenantId],
    );
    if (book.rowCount !== 1) {
      throw new VaultError('BOOK_NOT_FOUND', 'Treasury book not found', 404);
    }
    const record = book.rows[0];
    if (record.status !== 'OPEN') {
      throw new VaultError('BOOK_CLOSED', 'Closed books reject new rows', 409);
    }
    const rows = await loadRows(client, bookId);
    const map = runningPosition(rows);
    const last = rows[rows.length - 1];
    if (
      last
      && last.flowDirection === 'BAL'
      && last.accountingLabel === 'Bal c/d'
      && sameMap(map, mapFromCells(last.cells))
    ) {
      throw new VaultError('ALREADY_SQUARE', 'The carried-down row already matches the book', 409);
    }
    const created = await insertLedgerRow(client, {
      tenantId,
      bookId,
      transactionDate: record.business_date,
      custodianOneInitials,
      custodianTwoInitials,
      tellerCoordInitials,
      accountingLabel: 'Bal c/d',
      flowDirection: 'BAL',
      amounts: amountsFromCells(cellsFromMap(record.book_class, map)),
    }, { manageTransaction: false });
    const minors = positionByCurrency(record.book_class, cellsFromMap(record.book_class, map));
    for (const [currency, minor] of Object.entries(minors)) {
      await client.query(
        `INSERT INTO mock_core_positions
           (tenant_id, branch_id, book_id, currency_code, amount_minor)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, branch_id, book_id, currency_code)
         DO UPDATE SET amount_minor = EXCLUDED.amount_minor`,
        [tenantId, record.branch_id, bookId, currency, minor.toString()],
      );
    }
    if (owns) await client.query('COMMIT');
    return created;
  } catch (error) {
    if (owns) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    }
    throw error;
  } finally {
    if (owns) client.release();
  }
}

module.exports = {
  cellKey,
  composeRow,
  displayFor,
  rollForward,
  runningPosition,
  cellsFromMap,
  positionByCurrency,
  parsePosition,
  amountsFromCells,
  insertLedgerRow,
  loadRows,
  presentRows,
  getBookView,
  writeCarriedDown,
  translateLedgerError,
  inOrOut,
  initialsOf,
};
