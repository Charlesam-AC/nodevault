const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { carryForwardBranch } = require('../services/carry');
const { captureHandover, holdersForDate } = require('../services/rotation');
const { prepareDesk } = require('../server');
const { executeThreePersonVaultLock } = require('../services/closing');
const { createBookWithRows } = require('../services/books');
const { loadRows } = require('../services/ledger');
const { VaultError } = require('../services/errors');
const { DATE, kwachaRows, foreignRows, bancsRows } = require('../fixtures/sampleLedger');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const FRIDAY = '2026-10-02';
const MONDAY = '2026-10-05';
const MONDAY_MORNING = new Date('2026-10-05T06:00:00.000Z');
const CALENDAR = { holidays: [], timeZone: 'Africa/Lusaka', dayStart: '08:00' };

let pinHash;

async function openFriday(pool, desk) {
  const classes = {
    KWACHA_TREASURY: kwachaRows,
    FOREIGN_CURRENCY: foreignRows,
    BANCS_TREASURY: bancsRows,
  };
  const ids = [];
  for (const [bookClass, rows] of Object.entries(classes)) {
    ids.push(await createBookWithRows(pool, {
      tenantId: desk.tenantId,
      branchId: desk.branchId,
      bookClass,
      businessDate: FRIDAY,
      rows,
    }));
  }
  await pool.query(
    `UPDATE branch_vault_books
     SET status = 'BALANCED_CLOSED', closed_at = now()
     WHERE book_id = ANY($1::bigint[])`,
    [ids],
  );
}

async function reliefUser(pool, desk, email, name, employeeId, initials, role) {
  const inserted = await pool.query(
    `INSERT INTO nodevault_users (
       tenant_id, branch_id, work_email, full_legal_name, employee_id,
       two_letter_initials, system_role, closing_pin_hash, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
     RETURNING user_id, employee_id, two_letter_initials`,
    [desk.tenantId, desk.branchId, email, name, employeeId, initials, role, pinHash],
  );
  return inserted.rows[0];
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
  process.env.BUSINESS_TIMEZONE = 'Africa/Lusaka';
  process.env.BUSINESS_DAY_START = '08:00';
  process.env.BANK_HOLIDAYS = '';
});

test('the new cycle stays shut until handover is captured, and the log keeps the balances', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await openFriday(applicationPool, desk);

  const blocked = await holdersForDate(applicationPool, desk.tenantId, desk.branchId, MONDAY);
  assert.equal(blocked.open, false);
  const before = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, MONDAY_MORNING, CALENDAR,
  );
  assert.equal(before.skipped, 'HANDOVER_REQUIRED');
  const premature = await applicationPool.query(
    `SELECT book_id FROM branch_vault_books WHERE branch_id = $1 AND business_date = $2`,
    [desk.branchId, MONDAY],
  );
  assert.equal(premature.rowCount, 0);

  const deskView = await prepareDesk(applicationPool, {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
  }, MONDAY_MORNING);
  assert.equal(deskView.deskOpen, false);
  assert.equal(deskView.books.length, 0);

  const incoming = {
    CUSTODIAN_ONE: await reliefUser(applicationPool, desk, 'relief.one@demo-bank.example', 'Relief Custodian', 'CUST-0301', 'R.C.', 'VAULT_CUSTODIAN'),
    CUSTODIAN_TWO: await reliefUser(applicationPool, desk, 'relief.two@demo-bank.example', 'Second Relief Custodian', 'CUST-0302', 'S.R.', 'VAULT_CUSTODIAN'),
    HEAD_TELLER: await reliefUser(applicationPool, desk, 'relief.coord@demo-bank.example', 'Relief Coordinator', 'TELL-0902', 'R.K.', 'HEAD_TELLER_COORDINATOR'),
  };
  const captured = await captureHandover(applicationPool, {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    effectiveDate: MONDAY,
    posts: Object.entries(incoming).map(([postCode, user]) => ({
      postCode,
      incomingUserId: user.user_id,
      employeeId: user.employee_id,
      initials: user.two_letter_initials,
      outgoingPin: '135790',
      incomingPin: '135790',
    })),
  });
  assert.equal(captured.effectiveDate, MONDAY);
  assert.equal(captured.balances.KWACHA_TREASURY.REISSUABLE.K500, '1000000.00');
  assert.equal(captured.balances.FOREIGN_CURRENCY.USD['100'], '5500.00');
  assert.equal(captured.balances.BANCS_TREASURY.EUR['500'], '1000.00');

  const audit = await applicationPool.query(
    `SELECT detail FROM audit_events WHERE event_type = 'HANDOVER_CAPTURED'`,
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].detail.balances.KWACHA_TREASURY.REISSUABLE.K500, '1000000.00');
  assert.equal(audit.rows[0].detail.posts.length, 3);
  assert.equal(audit.rows[0].detail.posts.every((post) => post.outgoing.acknowledged && post.incoming.acknowledged), true);

  const log = await applicationPool.query(
    `SELECT balances FROM handover_logs WHERE branch_id = $1 AND effective_date = $2`,
    [desk.branchId, MONDAY],
  );
  assert.equal(log.rowCount, 1);

  const opened = await holdersForDate(applicationPool, desk.tenantId, desk.branchId, MONDAY);
  assert.equal(opened.open, true);
  const rolled = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, MONDAY_MORNING, CALENDAR,
  );
  assert.deepEqual(rolled.results.map((row) => row.status), ['POSTED', 'POSTED', 'POSTED']);
  const mondayBook = await applicationPool.query(
    `SELECT book_id FROM branch_vault_books
     WHERE branch_id = $1 AND book_class = 'KWACHA_TREASURY' AND business_date = $2`,
    [desk.branchId, MONDAY],
  );
  const rows = await loadRows(applicationPool, mondayBook.rows[0].book_id);
  assert.equal(rows[0].accountingLabel, 'Bal b/f');
  const kwacha = rows[0].cells.find((cell) => cell.channel === 'REISSUABLE' && cell.code === 'K500');
  assert.equal(kwacha.amountMinor.toString(), '100000000');
});

test('the closing interlock rejects a custodian or coordinator who is not assigned that date', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const stranger = await reliefUser(
    applicationPool, desk, 'other.coord@demo-bank.example', 'Other Coordinator', 'TELL-0999', 'O.C.', 'HEAD_TELLER_COORDINATOR',
  );
  const otherCustodian = await reliefUser(
    applicationPool, desk, 'other.custodian@demo-bank.example', 'Other Custodian', 'CUST-0999', 'O.K.', 'VAULT_CUSTODIAN',
  );

  await assert.rejects(
    () => executeThreePersonVaultLock(desk.tenantId, desk.branchId, {
      c1_id: desk.users.c1.user_id,
      c1_pin: desk.pin,
      c2_id: desk.users.c2.user_id,
      c2_pin: desk.pin,
      coord_id: stranger.user_id,
      coord_pin: desk.pin,
      target_book_id: desk.books.KWACHA_TREASURY,
      calculated_matrix_cash_total: { ZMW: '1656515.00' },
      operating_date: DATE,
    }, { pool: applicationPool }),
    (error) => error instanceof VaultError && error.code === 'COORDINATOR_NOT_ASSIGNED',
  );

  await assert.rejects(
    () => executeThreePersonVaultLock(desk.tenantId, desk.branchId, {
      c1_id: desk.users.c1.user_id,
      c1_pin: desk.pin,
      c2_id: otherCustodian.user_id,
      c2_pin: desk.pin,
      coord_id: desk.users.coord.user_id,
      coord_pin: desk.pin,
      target_book_id: desk.books.KWACHA_TREASURY,
      calculated_matrix_cash_total: { ZMW: '1656515.00' },
      operating_date: DATE,
    }, { pool: applicationPool }),
    (error) => error instanceof VaultError && error.code === 'CUSTODIAN_NOT_ASSIGNED',
  );
});
