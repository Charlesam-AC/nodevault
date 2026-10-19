const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { executeThreePersonVaultLock, dispatchClosing } = require('../services/closing');
const { VaultError } = require('../services/errors');
const { DATE } = require('../fixtures/sampleLedger');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const DECLARED = {
  KWACHA_TREASURY: { ZMW: '1656515.00' },
  FOREIGN_CURRENCY: { EUR: '0.00', GBP: '0.00', USD: '8000.00', ZAR: '25000.00' },
  BANCS_TREASURY: { EUR: '1500.00', GBP: '500.00', USD: '220.00', ZAR: '400.00' },
};

let pinHash;

async function statusOf(bookId) {
  const { applicationPool } = pools();
  const result = await applicationPool.query(
    'SELECT status FROM branch_vault_books WHERE book_id = $1',
    [bookId],
  );
  return result.rows[0].status;
}

function payload(desk, bookClass, overrides = {}) {
  return {
    c1_id: desk.users.c1.user_id,
    c1_pin: desk.pin,
    c2_id: desk.users.c2.user_id,
    c2_pin: desk.pin,
    coord_id: desk.users.coord.user_id,
    coord_pin: desk.pin,
    target_book_id: desk.books[bookClass],
    calculated_matrix_cash_total: DECLARED[bookClass],
    operating_date: DATE,
    ...overrides,
  };
}

async function closeBook(desk, bookClass, deps = {}) {
  const { applicationPool } = pools();
  return executeThreePersonVaultLock(
    desk.tenantId,
    desk.branchId,
    payload(desk, bookClass),
    { pool: applicationPool, ...deps },
  );
}

test.before(async () => {
  await setupPools();
  pinHash = await bcrypt.hash('135790', 6);
});

test.after(async () => {
  await closePools();
});

test.beforeEach(async () => {
  await resetDatabase();
});

test('closes each of the three books on a zero-variance match', async () => {
  const desk = await createDesk(pinHash);
  const seen = [];
  const mailed = [];
  const printer = async (job) => {
    const { applicationPool } = pools();
    const client = await applicationPool.connect();
    try {
      const result = await client.query(
        'SELECT status FROM branch_vault_books WHERE book_id = $1',
        [job.bookId],
      );
      seen.push(result.rows[0].status);
    } finally {
      client.release();
    }
  };
  const mailer = async (job) => {
    mailed.push(job);
  };
  for (const bookClass of ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY']) {
    const result = await closeBook(desk, bookClass, { printer, mailer });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.dispatch.every((item) => item.status === 'SENT'), true);
  }
  assert.deepEqual(seen, ['BALANCED_CLOSED', 'BALANCED_CLOSED', 'BALANCED_CLOSED']);
  assert.equal(mailed.length, 3);
  assert.deepEqual(mailed[0].to.sort(), [
    'charles.amulike@demo-bank.example',
    'custodian.two@demo-bank.example',
  ].sort());
  assert.ok(mailed[0].cc.includes('rom@demo-bank.example'));
  assert.match(mailed[0].text, /NODEVAULT CLOSING SHEET\nFNB Zambia Limited\n/);
  for (const bookId of Object.values(desk.books)) {
    assert.equal(await statusOf(bookId), 'BALANCED_CLOSED');
  }
});

test('rejects a wrong closing PIN and leaves the book open', async () => {
  const desk = await createDesk(pinHash);
  const { applicationPool } = pools();
  let printed = 0;
  await assert.rejects(
    () => executeThreePersonVaultLock(
      desk.tenantId,
      desk.branchId,
      payload(desk, 'KWACHA_TREASURY', { c2_pin: '0000' }),
      { pool: applicationPool, printer: async () => { printed += 1; } },
    ),
    (error) => error instanceof VaultError && error.code === 'WRONG_PIN',
  );
  assert.equal(printed, 0);
  assert.equal(await statusOf(desk.books.KWACHA_TREASURY), 'OPEN');
});

test('rejects a duplicated custodian', async () => {
  const desk = await createDesk(pinHash);
  const { applicationPool } = pools();
  await assert.rejects(
    () => executeThreePersonVaultLock(
      desk.tenantId,
      desk.branchId,
      payload(desk, 'FOREIGN_CURRENCY', { c2_id: desk.users.c1.user_id }),
      { pool: applicationPool, printer: async () => { throw new Error('should not print'); } },
    ),
    (error) => error.code === 'DUPLICATE_SIGNATORY',
  );
  assert.equal(await statusOf(desk.books.FOREIGN_CURRENCY), 'OPEN');
});

test('rejects a signatory with the wrong role', async () => {
  const desk = await createDesk(pinHash);
  const { applicationPool } = pools();
  await assert.rejects(
    () => executeThreePersonVaultLock(
      desk.tenantId,
      desk.branchId,
      payload(desk, 'BANCS_TREASURY', { c2_id: desk.users.teller.user_id }),
      { pool: applicationPool },
    ),
    (error) => error.code === 'WRONG_ROLE',
  );
  assert.equal(await statusOf(desk.books.BANCS_TREASURY), 'OPEN');
});

test('rejects a one-ngwee variance and does not print', async () => {
  const desk = await createDesk(pinHash);
  const { applicationPool } = pools();
  await applicationPool.query(
    `UPDATE mock_core_positions
     SET amount_minor = amount_minor + 1
     WHERE book_id = $1 AND currency_code = 'ZMW'`,
    [desk.books.KWACHA_TREASURY],
  );
  let printed = 0;
  await assert.rejects(
    () => executeThreePersonVaultLock(
      desk.tenantId,
      desk.branchId,
      payload(desk, 'KWACHA_TREASURY'),
      { pool: applicationPool, printer: async () => { printed += 1; } },
    ),
    (error) => error.code === 'VARIANCE',
  );
  assert.equal(printed, 0);
  assert.equal(await statusOf(desk.books.KWACHA_TREASURY), 'OPEN');
});

test('a printer failure after commit does not reopen the book', async () => {
  const desk = await createDesk(pinHash);
  const { applicationPool } = pools();
  const result = await executeThreePersonVaultLock(
    desk.tenantId,
    desk.branchId,
    payload(desk, 'KWACHA_TREASURY'),
    {
      pool: applicationPool,
      printer: async () => { throw new Error('printer offline'); },
      mailer: async () => {},
    },
  );
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.dispatch.find((item) => item.kind === 'PRINT').status, 'FAILED');
  assert.equal(await statusOf(desk.books.KWACHA_TREASURY), 'BALANCED_CLOSED');
  const audit = await applicationPool.query(
    `SELECT event_type FROM audit_events WHERE book_id = $1 AND event_type = 'DISPATCH_FAILED'`,
    [desk.books.KWACHA_TREASURY],
  );
  assert.equal(audit.rowCount, 1);
  const retried = await dispatchClosing(
    applicationPool,
    { tenantId: desk.tenantId, bookId: desk.books.KWACHA_TREASURY },
    { printer: async () => {}, mailer: async () => {} },
  );
  assert.equal(retried.length, 1);
  assert.equal(retried[0].kind, 'PRINT');
  assert.equal(retried[0].status, 'SENT');
  assert.equal(await statusOf(desk.books.KWACHA_TREASURY), 'BALANCED_CLOSED');
});
