const { VaultError } = require('./errors');
const { toMinor } = require('./money');

function parseOutstanding(body) {
  const outstanding = body && body.outstanding;
  if (!outstanding || typeof outstanding !== 'object' || Array.isArray(outstanding)) {
    throw new VaultError('CORE_BANK_AMOUNT', 'Core bank response is missing outstanding balances', 502);
  }
  const result = {};
  for (const [currency, amount] of Object.entries(outstanding)) {
    try {
      result[currency] = toMinor(amount);
    } catch (error) {
      throw new VaultError(
        'CORE_BANK_AMOUNT',
        `Core bank amounts must be decimal strings (${currency})`,
        502,
      );
    }
  }
  return result;
}

async function getOutstandingPosition(db, { tenantId, branchId, bookId }) {
  const mode = process.env.CORE_BANK_MODE || 'mock';
  if (mode === 'mock') {
    const result = await db.query(
      `SELECT currency_code, amount_minor
       FROM mock_core_positions
       WHERE tenant_id = $1 AND branch_id = $2 AND book_id = $3`,
      [tenantId, branchId, bookId],
    );
    const outstanding = {};
    for (const row of result.rows) {
      outstanding[row.currency_code.trim()] = BigInt(row.amount_minor);
    }
    return outstanding;
  }
  if (mode === 'http') {
    const base = process.env.CORE_BANK_API_URL;
    if (!base) {
      throw new VaultError('CORE_BANK_UNAVAILABLE', 'CORE_BANK_API_URL is required', 503);
    }
    const url = new URL(`/v1/position/${branchId}`, base.endsWith('/') ? base : `${base}/`);
    url.searchParams.set('tenant_id', String(tenantId));
    url.searchParams.set('book_id', String(bookId));
    let response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (error) {
      throw new VaultError('CORE_BANK_UNAVAILABLE', 'Core banking position could not be read', 503);
    }
    if (!response.ok) {
      throw new VaultError('CORE_BANK_UNAVAILABLE', `Core banking position returned ${response.status}`, 503);
    }
    return parseOutstanding(await response.json());
  }
  throw new VaultError('CORE_BANK_UNAVAILABLE', `Unknown CORE_BANK_MODE ${mode}`, 503);
}

async function listCoreTransactions(db, { tenantId, branchId, bookClass, from, to }) {
  const mode = process.env.CORE_BANK_MODE || 'mock';
  if (mode === 'mock') {
    const result = await db.query(
      `SELECT core_tx_id, book_class, business_date::text AS business_date, posted_at,
              reference, description, currency_code, amount_minor
       FROM mock_core_transactions
       WHERE tenant_id = $1 AND branch_id = $2 AND book_class = $3
         AND business_date BETWEEN $4::date AND $5::date
       ORDER BY business_date, reference`,
      [tenantId, branchId, bookClass, from, to],
    );
    return result.rows.map((row) => ({
      core_tx_id: Number(row.core_tx_id),
      book_class: row.book_class,
      business_date: row.business_date,
      posted_at: row.posted_at,
      reference: row.reference,
      description: row.description,
      currency_code: row.currency_code.trim(),
      amount_minor: row.amount_minor.toString(),
    }));
  }
  if (mode === 'http') {
    const base = process.env.CORE_BANK_API_URL;
    if (!base) throw new VaultError('CORE_BANK_UNAVAILABLE', 'CORE_BANK_API_URL is required', 503);
    const url = new URL(`/v1/transactions/${branchId}`, base.endsWith('/') ? base : `${base}/`);
    url.searchParams.set('book_class', bookClass);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    let response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (_error) {
      throw new VaultError('CORE_BANK_UNAVAILABLE', 'Core banking transactions could not be read', 503);
    }
    if (!response.ok) {
      throw new VaultError('CORE_BANK_UNAVAILABLE', `Core banking transactions returned ${response.status}`, 503);
    }
    const body = await response.json();
    return Array.isArray(body.transactions) ? body.transactions : [];
  }
  throw new VaultError('CORE_BANK_UNAVAILABLE', `Unknown CORE_BANK_MODE ${mode}`, 503);
}

module.exports = { getOutstandingPosition, parseOutstanding, listCoreTransactions };
