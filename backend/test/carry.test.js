const test = require('node:test');
const assert = require('node:assert/strict');
const { carryForwardBranch } = require('../services/carry');
const { createBookWithRows } = require('../services/books');
const { loadRows } = require('../services/ledger');
const { kwachaRows, foreignRows, bancsRows } = require('../fixtures/sampleLedger');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const FRIDAY = '2026-10-02';
const MONDAY = '2026-10-05';
const TUESDAY = '2026-10-06';
const MONDAY_MORNING = new Date('2026-10-05T06:00:00.000Z');
const MONDAY_EARLY = new Date('2026-10-05T05:59:00.000Z');
const SATURDAY_MORNING = new Date('2026-10-03T06:00:00.000Z');
const TUESDAY_MORNING = new Date('2026-10-06T06:00:00.000Z');
const CALENDAR = { holidays: [], timeZone: 'Africa/Lusaka', dayStart: '08:00' };

let pinHash;

function denomMap(cells) {
  const out = {};
  for (const cell of cells) {
    if (cell.kind !== 'DENOMINATION') continue;
    out[`${cell.channel}|${cell.code}`] = cell.amountMinor.toString();
  }
  return out;
}

async function extendRoster(pool, desk) {
  const seats = [
    ['CUSTODIAN_ONE', desk.users.c1.user_id],
    ['CUSTODIAN_TWO', desk.users.c2.user_id],
    ['HEAD_TELLER', desk.users.coord.user_id],
  ];
  for (const [postCode, userId] of seats) {
    await pool.query(
      `INSERT INTO post_assignments
         (tenant_id, branch_id, post_code, user_id, period_start, period_end)
       VALUES ($1, $2, $3, $4, '2026-10-05', '2026-10-11')`,
      [desk.tenantId, desk.branchId, postCode, userId],
    );
  }
}

async function openFriday(pool, desk, { close } = { close: true }) {
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
  if (close) {
    await pool.query(
      `UPDATE branch_vault_books
       SET status = 'BALANCED_CLOSED', closed_at = now()
       WHERE book_id = ANY($1::bigint[])`,
      [ids],
    );
  }
  return ids;
}

test.before(async () => {
  await setupPools();
  const bcrypt = require('bcryptjs');
  pinHash = await bcrypt.hash('135790', 6);
});

test.after(async () => {
  await closePools();
});

test.beforeEach(async () => {
  await resetDatabase();
});

test('rollover posts Bal b/f equal to the prior Bal c/d for all three books and does not double-post', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await extendRoster(applicationPool, desk);
  await openFriday(applicationPool, desk);

  const first = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, MONDAY_MORNING, CALENDAR,
  );
  assert.equal(first.businessDate, MONDAY);
  assert.equal(first.priorBusinessDate, FRIDAY);
  assert.deepEqual(first.results.map((row) => row.status), ['POSTED', 'POSTED', 'POSTED']);

  const second = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, MONDAY_MORNING, CALENDAR,
  );
  assert.deepEqual(second.results.map((row) => row.status), ['ALREADY', 'ALREADY', 'ALREADY']);

  const books = await applicationPool.query(
    `SELECT book_id, book_class FROM branch_vault_books
     WHERE branch_id = $1 AND business_date = $2
     ORDER BY book_class`,
    [desk.branchId, MONDAY],
  );
  assert.equal(books.rowCount, 3);
  for (const book of books.rows) {
    const opened = await loadRows(applicationPool, book.book_id);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].accountingLabel, 'Bal b/f');
    assert.equal(opened[0].flowDirection, 'BAL');
    const prior = await applicationPool.query(
      `SELECT book_id FROM branch_vault_books
       WHERE branch_id = $1 AND book_class = $2 AND business_date = $3`,
      [desk.branchId, book.book_class, FRIDAY],
    );
    const closed = await loadRows(applicationPool, prior.rows[0].book_id);
    const carried = closed[closed.length - 1];
    assert.equal(carried.accountingLabel, 'Bal c/d');
    assert.deepEqual(denomMap(opened[0].cells), denomMap(carried.cells));
  }
});

test('the morning job skips weekends, holidays, and the time before the business day starts', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await extendRoster(applicationPool, desk);
  await openFriday(applicationPool, desk);

  const weekend = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, SATURDAY_MORNING, CALENDAR,
  );
  assert.equal(weekend.skipped, 'NOT_A_BUSINESS_MORNING');

  const early = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, MONDAY_EARLY, CALENDAR,
  );
  assert.equal(early.skipped, 'NOT_A_BUSINESS_MORNING');

  const holiday = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, MONDAY_MORNING,
    { ...CALENDAR, holidays: [MONDAY] },
  );
  assert.equal(holiday.skipped, 'NOT_A_BUSINESS_MORNING');

  const tuesday = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, TUESDAY_MORNING,
    { ...CALENDAR, holidays: [MONDAY] },
  );
  assert.equal(tuesday.businessDate, TUESDAY);
  assert.equal(tuesday.priorBusinessDate, FRIDAY);
  assert.deepEqual(tuesday.results.map((row) => row.status), ['POSTED', 'POSTED', 'POSTED']);

  const dates = await applicationPool.query(
    `SELECT business_date::text AS business_date
     FROM branch_vault_books
     WHERE branch_id = $1 AND business_date >= '2026-10-05'
     ORDER BY business_date`,
    [desk.branchId],
  );
  assert.deepEqual(dates.rows.map((row) => row.business_date), [TUESDAY, TUESDAY, TUESDAY]);
});

test('an unclosed prior business day is flagged and not rolled forward', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await extendRoster(applicationPool, desk);
  await openFriday(applicationPool, desk, { close: false });

  const result = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, MONDAY_MORNING, CALENDAR,
  );
  assert.deepEqual(result.results.map((row) => row.reason), ['NOT_CLOSED', 'NOT_CLOSED', 'NOT_CLOSED']);

  const opened = await applicationPool.query(
    `SELECT book_id FROM branch_vault_books WHERE branch_id = $1 AND business_date = $2`,
    [desk.branchId, MONDAY],
  );
  assert.equal(opened.rowCount, 0);
  const flags = await applicationPool.query(
    `SELECT book_class, reason FROM carry_forward_flags
     WHERE branch_id = $1 AND business_date = $2
     ORDER BY book_class`,
    [desk.branchId, MONDAY],
  );
  assert.equal(flags.rowCount, 3);

  const again = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, MONDAY_MORNING, CALENDAR,
  );
  assert.deepEqual(again.results.map((row) => row.reason), ['NOT_CLOSED', 'NOT_CLOSED', 'NOT_CLOSED']);
  const audits = await applicationPool.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'CARRY_FORWARD_BLOCKED'`,
  );
  assert.equal(audits.rows[0].n, 3);
});
