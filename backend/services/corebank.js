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

module.exports = { getOutstandingPosition, parseOutstanding };
