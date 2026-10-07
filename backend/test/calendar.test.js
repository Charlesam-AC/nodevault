const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { easterSunday, zambiaHolidays, holidayDates } = require('../services/zambiaHolidays');
const { isBusinessDay } = require('../services/calendar');
const {
  declareClosure,
  declareNonWorkingDay,
  cancelClosure,
  declareGazetted,
  cancelGazetted,
  optionsForBranch,
} = require('../services/closures');
const { carryForwardBranch } = require('../services/carry');
const { createBookWithRows } = require('../services/books');
const { VaultError } = require('../services/errors');
const { kwachaRows, foreignRows, bancsRows } = require('../fixtures/sampleLedger');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const OPEN = { timeZone: 'Africa/Lusaka', dayStart: '08:00' };
const WEEK = [1, 2, 3, 4, 5, 6];
const AS_OF = new Date('2026-09-01T06:00:00.000Z');

let pinHash;

function stamp(rows) {
  return rows.map((row) => ({ date: row.date, name: row.name, observance: row.observance }));
}

async function lockBooks(pool, desk, branchId, businessDate) {
  const classes = {
    KWACHA_TREASURY: kwachaRows,
    FOREIGN_CURRENCY: foreignRows,
    BANCS_TREASURY: bancsRows,
  };
  const ids = [];
  for (const [bookClass, rows] of Object.entries(classes)) {
    ids.push(await createBookWithRows(pool, {
      tenantId: desk.tenantId,
      branchId,
      bookClass,
      businessDate,
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

async function cover(pool, desk, branchId, start, end, users) {
  const seats = [
    ['CUSTODIAN_ONE', users.c1],
    ['CUSTODIAN_TWO', users.c2],
    ['HEAD_TELLER', users.coord],
  ];
  for (const [postCode, userId] of seats) {
    await pool.query(
      `INSERT INTO post_assignments
         (tenant_id, branch_id, post_code, user_id, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [desk.tenantId, branchId, postCode, userId, start, end],
    );
  }
}

async function otherBranch(pool, desk) {
  const inserted = await pool.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name, province, location_name)
     VALUES ($1, 'CB01', 'Kitwe Branch', 'Copperbelt', 'Kitwe')
     RETURNING branch_id`,
    [desk.tenantId],
  );
  const branchId = Number(inserted.rows[0].branch_id);
  const seats = [
    ['CUSTODIAN_ONE', desk.users.c1.user_id],
    ['CUSTODIAN_TWO', desk.users.c2.user_id],
    ['HEAD_TELLER', desk.users.coord.user_id],
  ];
  for (const [postCode, userId] of seats) {
    await pool.query(
      `INSERT INTO rotation_schedules (tenant_id, branch_id, post_code, cadence, anchor_date)
       VALUES ($1, $2, $3, 'WEEKLY', '2026-09-28')`,
      [desk.tenantId, branchId, postCode],
    );
    await pool.query(
      `INSERT INTO post_assignments
         (tenant_id, branch_id, post_code, user_id, period_start, period_end)
       VALUES ($1, $2, $3, $4, '2026-09-28', '2026-10-04')`,
      [desk.tenantId, branchId, postCode, userId],
    );
  }
  return branchId;
}

async function rom(pool, desk) {
  const inserted = await pool.query(
    `INSERT INTO nodevault_users (
       tenant_id, branch_id, work_email, full_legal_name, employee_id,
       two_letter_initials, system_role, closing_pin_hash, is_active
     ) VALUES ($1,$2,'rom.desk@demo-bank.example','Regional Operations Manager','ROM-0099','R.O.','REGIONAL_OPS_MANAGER',$3,true)
     RETURNING user_id`,
    [desk.tenantId, desk.branchId, pinHash],
  );
  return {
    tenantId: desk.tenantId,
    userId: Number(inserted.rows[0].user_id),
    role: 'REGIONAL_OPS_MANAGER',
    now: AS_OF,
  };
}

async function closed(pool, tenantId, branchId, isoDate) {
  const options = await optionsForBranch(pool, tenantId, branchId, { ...OPEN, anchorDate: isoDate });
  return !isBusinessDay(isoDate, options);
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

test('Easter and the 2026 Zambian holiday list follow the Act and the Sunday rule', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  const year2026 = stamp(zambiaHolidays(2026));
  assert.deepEqual(year2026, [
    { date: '2026-01-01', name: "New Year's Day", observance: 'STATUTORY' },
    { date: '2026-03-08', name: "International Women's Day", observance: 'STATUTORY' },
    { date: '2026-03-09', name: "International Women's Day", observance: 'SUNDAY_FOLLOWING' },
    { date: '2026-03-12', name: 'Youth Day', observance: 'STATUTORY' },
    { date: '2026-04-03', name: 'Good Friday', observance: 'STATUTORY' },
    { date: '2026-04-04', name: 'Holy Saturday', observance: 'STATUTORY' },
    { date: '2026-04-06', name: 'Easter Monday', observance: 'STATUTORY' },
    { date: '2026-04-28', name: 'Kenneth Kaunda Day', observance: 'STATUTORY' },
    { date: '2026-05-01', name: 'Labour Day', observance: 'STATUTORY' },
    { date: '2026-05-25', name: 'Africa Freedom Day', observance: 'STATUTORY' },
    { date: '2026-07-06', name: 'Heroes Day', observance: 'STATUTORY' },
    { date: '2026-07-07', name: 'Unity Day', observance: 'STATUTORY' },
    { date: '2026-08-03', name: "Farmers' Day", observance: 'STATUTORY' },
    { date: '2026-10-18', name: 'National Day of Prayer, Fasting, Repentance and Reconciliation', observance: 'STATUTORY' },
    { date: '2026-10-19', name: 'National Day of Prayer, Fasting, Repentance and Reconciliation', observance: 'SUNDAY_FOLLOWING' },
    { date: '2026-10-24', name: 'Independence Day', observance: 'STATUTORY' },
    { date: '2026-12-25', name: 'Christmas Day', observance: 'STATUTORY' },
  ]);
  assert.equal(year2026.some((row) => row.date === '2026-04-27'), false);

  const dates2026 = holidayDates(2026);
  assert.equal(isBusinessDay('2026-03-09', { holidays: dates2026, tradingWeekdays: WEEK }), false);
  assert.equal(isBusinessDay('2026-03-10', { holidays: dates2026, tradingWeekdays: WEEK }), true);
  assert.equal(isBusinessDay('2026-10-19', { holidays: dates2026, tradingWeekdays: WEEK }), false);
  assert.equal(isBusinessDay('2026-10-24', { holidays: dates2026, tradingWeekdays: WEEK }), false);
  assert.equal(isBusinessDay('2026-10-26', { holidays: dates2026, tradingWeekdays: WEEK }), true);

  const easter2027 = stamp(zambiaHolidays(2027).filter((row) => (
    ['Good Friday', 'Holy Saturday', 'Easter Monday', 'Independence Day'].includes(row.name)
  )));
  assert.deepEqual(easter2027, [
    { date: '2027-03-26', name: 'Good Friday', observance: 'STATUTORY' },
    { date: '2027-03-27', name: 'Holy Saturday', observance: 'STATUTORY' },
    { date: '2027-03-29', name: 'Easter Monday', observance: 'STATUTORY' },
    { date: '2027-10-24', name: 'Independence Day', observance: 'STATUTORY' },
    { date: '2027-10-25', name: 'Independence Day', observance: 'SUNDAY_FOLLOWING' },
  ]);
});

test('a national holiday is skipped and the next morning rolls across it', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash, { withBooks: false });
  await cover(applicationPool, desk, desk.branchId, '2026-04-27', '2026-05-09', {
    c1: desk.users.c1.user_id,
    c2: desk.users.c2.user_id,
    coord: desk.users.coord.user_id,
  });
  await lockBooks(applicationPool, desk, desk.branchId, '2026-04-30');

  const holiday = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, new Date('2026-05-01T06:00:00.000Z'), OPEN,
  );
  assert.equal(holiday.skipped, 'NOT_A_BUSINESS_MORNING');

  const saturday = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, new Date('2026-05-02T06:00:00.000Z'), OPEN,
  );
  assert.equal(saturday.businessDate, '2026-05-02');
  assert.equal(saturday.priorBusinessDate, '2026-04-30');
  assert.deepEqual(saturday.results.map((row) => row.status), ['POSTED', 'POSTED', 'POSTED']);
  const friday = await applicationPool.query(
    `SELECT book_id FROM branch_vault_books WHERE branch_id = $1 AND business_date = '2026-05-01'`,
    [desk.branchId],
  );
  assert.equal(friday.rowCount, 0);
});

test('a branch closure stays local, a tenant closure covers every branch, and a cancelled closure does not', async () => {
  const { applicationPool, adminPool } = pools();
  const desk = await createDesk(pinHash);
  const kitwe = await otherBranch(applicationPool, desk);
  const actor = await rom(applicationPool, desk);
  const stranger = { ...actor, role: 'IT_SUPER_ADMIN' };

  await assert.rejects(
    () => declareClosure(applicationPool, stranger, {
      scope: 'BRANCH',
      branchIds: [desk.branchId],
      startDate: '2026-09-30',
      endDate: '2026-09-30',
      reason: 'Local shutdown',
    }),
    (error) => error instanceof VaultError && error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => declareClosure(applicationPool, actor, {
      scope: 'BRANCH',
      branchIds: [desk.branchId],
      startDate: '2026-10-03',
      endDate: '2026-10-03',
      reason: 'Too late, the book exists',
    }),
    (error) => error instanceof VaultError && error.code === 'CLOSURE_HAS_BOOKS',
  );

  const local = await declareClosure(applicationPool, actor, {
    scope: 'BRANCH',
    branchIds: [desk.branchId],
    startDate: '2026-09-30',
    endDate: '2026-09-30',
    reason: 'Lusaka civic holiday',
  });
  assert.equal(await closed(applicationPool, desk.tenantId, desk.branchId, '2026-09-30'), true);
  assert.equal(await closed(applicationPool, desk.tenantId, kitwe, '2026-09-30'), false);

  await cancelClosure(applicationPool, actor, local.closureId);
  assert.equal(await closed(applicationPool, desk.tenantId, desk.branchId, '2026-09-30'), false);
  const audits = await applicationPool.query(
    `SELECT event_type FROM audit_events WHERE event_type IN ('CLOSURE_DECLARED', 'CLOSURE_CANCELLED') ORDER BY event_type`,
  );
  assert.deepEqual(audits.rows.map((row) => row.event_type), ['CLOSURE_CANCELLED', 'CLOSURE_DECLARED']);
  await assert.rejects(() => adminPool.query('DELETE FROM non_working_closures WHERE closure_id = $1', [local.closureId]));

  const national = await declareClosure(applicationPool, actor, {
    scope: 'TENANT',
    startDate: '2026-09-30',
    endDate: '2026-09-30',
    reason: 'Bank-wide shutdown',
  });
  assert.equal(await closed(applicationPool, desk.tenantId, desk.branchId, '2026-09-30'), true);
  assert.equal(await closed(applicationPool, desk.tenantId, kitwe, '2026-09-30'), true);
  await cancelClosure(applicationPool, actor, national.closureId);

  const gazette = await declareGazetted(applicationPool, actor, {
    holidayDate: '2026-11-03',
    name: 'State occasion',
    gazetteReference: 'Gazette Notice 1 of 2026',
  });
  assert.equal(await closed(applicationPool, desk.tenantId, desk.branchId, '2026-11-03'), true);
  assert.equal(await closed(applicationPool, desk.tenantId, kitwe, '2026-11-03'), true);
  await cancelGazetted(applicationPool, actor, gazette.holidayId);
  assert.equal(await closed(applicationPool, desk.tenantId, desk.branchId, '2026-11-03'), false);

  await declareClosure(applicationPool, actor, {
    scope: 'BRANCH',
    branchIds: [desk.branchId],
    startDate: '2026-09-30',
    endDate: '2026-09-30',
    reason: 'Lusaka civic holiday',
  });
  await lockBooks(applicationPool, desk, desk.branchId, '2026-09-29');
  await lockBooks(applicationPool, desk, desk.branchId, '2026-09-30');
  await lockBooks(applicationPool, desk, kitwe, '2026-09-29');
  await lockBooks(applicationPool, desk, kitwe, '2026-09-30');

  const lusaka = await carryForwardBranch(
    applicationPool, desk.tenantId, desk.branchId, new Date('2026-10-01T06:00:00.000Z'), OPEN,
  );
  assert.equal(lusaka.priorBusinessDate, '2026-09-29');
  assert.deepEqual(lusaka.results.map((row) => row.status), ['POSTED', 'POSTED', 'POSTED']);

  const copperbelt = await carryForwardBranch(
    applicationPool, desk.tenantId, kitwe, new Date('2026-10-01T06:00:00.000Z'), OPEN,
  );
  assert.equal(copperbelt.priorBusinessDate, '2026-09-30');
  assert.deepEqual(copperbelt.results.map((row) => row.status), ['POSTED', 'POSTED', 'POSTED']);
});

test('the master admin can set one non-working day, and a frozen IT admin cannot', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash, { withBooks: false });
  const inserted = await applicationPool.query(
    `INSERT INTO nodevault_users (
       tenant_id, branch_id, work_email, full_legal_name, employee_id,
       two_letter_initials, system_role, closing_pin_hash, is_active
     ) VALUES ($1,$2,'admin@demo-bank.example','Master Admin','ADM-TEST','M.A.','IT_SUPER_ADMIN',$3,true)
     RETURNING user_id`,
    [desk.tenantId, desk.branchId, pinHash],
  );
  const admin = {
    tenantId: desk.tenantId,
    userId: Number(inserted.rows[0].user_id),
    role: 'IT_SUPER_ADMIN',
    email: 'admin@demo-bank.example',
    branchId: desk.branchId,
    now: AS_OF,
  };
  const frozen = {
    tenantId: desk.tenantId,
    userId: Number(desk.users.admin.user_id),
    role: 'IT_SUPER_ADMIN',
    email: 'it.admin@demo-bank.example',
    branchId: desk.branchId,
    now: AS_OF,
  };
  await assert.rejects(
    () => declareNonWorkingDay(applicationPool, frozen, {
      branch_id: desk.branchId,
      non_working_date: '2026-11-12',
      reason: 'Stocktake',
    }),
    (error) => error instanceof VaultError && error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => declareNonWorkingDay(applicationPool, { ...admin, actorUserId: desk.users.c1.user_id }, {
      branch_id: desk.branchId,
      non_working_date: '2026-11-12',
      reason: 'Stocktake',
    }),
    (error) => error instanceof VaultError && error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => declareClosure(applicationPool, admin, {
      scope: 'TENANT',
      startDate: '2026-11-12',
      endDate: '2026-11-13',
      reason: 'Wider than one day',
    }),
    (error) => error instanceof VaultError && error.code === 'FORBIDDEN',
  );
  const day = await declareNonWorkingDay(applicationPool, admin, {
    branch_id: desk.branchId,
    non_working_date: '2026-11-12',
    reason: 'Branch stocktake',
  });
  assert.equal(day.startDate, '2026-11-12');
  assert.equal(day.endDate, '2026-11-12');
  assert.equal(await closed(applicationPool, desk.tenantId, desk.branchId, '2026-11-12'), true);
  const kitwe = await otherBranch(applicationPool, desk);
  assert.equal(await closed(applicationPool, desk.tenantId, kitwe, '2026-11-12'), false);
  await cancelClosure(applicationPool, admin, day.closureId);
  assert.equal(await closed(applicationPool, desk.tenantId, desk.branchId, '2026-11-12'), false);
});
