const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { captureHandover } = require('../services/rotation');
const { getBookView, insertLedgerRow, writeCarriedDown } = require('../services/ledger');
const { createBookWithRows } = require('../services/books');
const fs = require('fs');
const path = require('path');
const {
  listMovementOptions,
  addMovementOption,
} = require('../services/movements');
const { recordSurpriseCheck } = require('../services/surprise');
const { VaultError } = require('../services/errors');
const { DATE, kwachaRows } = require('../fixtures/sampleLedger');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const MONDAY = '2026-10-05';
const TAKEN_AT = new Date('2026-10-05T06:00:00.000Z');
const BY = 'Relief Custodian, CUST-0301 and Second Relief Custodian, CUST-0302';
const FROM = 'Charles Amulike, CUST-0149 and Secondary Custodian, CUST-0288';
const WHEN = '05/10/2026 08:00';

function takeover(totals) {
  return `Takeover cash check was done and found to be correct as ${totals} by "${BY}" from "${FROM}" on "${WHEN}".  All pages checks correctly and intact.  "${BY}"`;
}

const KWACHA_NARRATION = takeover(
  '"1,656,515.00" "(one million six hundred and fifty-six thousand five hundred and fifteen kwacha and zero ngwee)"',
);
const FOREIGN_NARRATION = takeover(
  '"EUR 0.00" "(zero euro)", "GBP 0.00" "(zero pounds)", "USD 8,000.00" "(eight thousand dollars)", "ZAR 25,000.00" "(twenty-five thousand rand)"',
);
const BANCS_NARRATION = takeover(
  '"EUR 1,500.00" "(one thousand five hundred euro)", "GBP 500.00" "(five hundred pounds)", "USD 220.00" "(two hundred and twenty dollars)", "ZAR 400.00" "(four hundred rand)"',
);

let pinHash;

async function relief(pool, desk, email, name, employeeId, initials, role) {
  const inserted = await pool.query(
    `INSERT INTO nodevault_users (
       tenant_id, branch_id, work_email, full_legal_name, employee_id,
       two_letter_initials, system_role, closing_pin_hash, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
     RETURNING user_id, employee_id, two_letter_initials, full_legal_name, system_role, work_email`,
    [desk.tenantId, desk.branchId, email, name, employeeId, initials, role, pinHash],
  );
  return inserted.rows[0];
}

function postsFor(users) {
  return Object.entries(users).map(([postCode, user]) => ({
    postCode,
    incomingUserId: user.user_id,
    employeeId: user.employee_id,
    initials: user.two_letter_initials,
    outgoingPin: '135790',
    incomingPin: '135790',
  }));
}

async function lockSample(pool, desk) {
  await pool.query(
    `UPDATE branch_vault_books
     SET status = 'BALANCED_CLOSED', closed_at = now()
     WHERE branch_id = $1 AND business_date = $2`,
    [desk.branchId, DATE],
  );
}

async function ledgerFingerprint(pool) {
  const cells = await pool.query(`SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM ledger_amount_cells`);
  const labels = await pool.query(
    `SELECT accounting_label, line_number, book_id
     FROM vault_denomination_matrix_ledger
     WHERE accounting_label IN ('Bal b/f', 'Bal b/d', 'Bal c/d')
     ORDER BY book_id, line_number`,
  );
  return {
    cells: cells.rows[0].total,
    labels: labels.rows.map((row) => `${row.book_id}:${row.line_number}:${row.accounting_label}`).join('|'),
  };
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
  process.env.MASTER_ADMIN_EMAIL = 'admin@demo-bank.example';
});

test('a committed custodian takeover writes one exact narration on each book', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const setup = await getBookView(applicationPool, desk.tenantId, desk.books.KWACHA_TREASURY);
  assert.equal(setup.narration, null);
  assert.equal(setup.rows[0].accounting_label, 'Bal b/f');

  await lockSample(applicationPool, desk);
  const incoming = {
    CUSTODIAN_ONE: await relief(applicationPool, desk, 'relief.one@demo-bank.example', 'Relief Custodian', 'CUST-0301', 'R.C.', 'VAULT_CUSTODIAN'),
    CUSTODIAN_TWO: await relief(applicationPool, desk, 'relief.two@demo-bank.example', 'Second Relief Custodian', 'CUST-0302', 'S.R.', 'VAULT_CUSTODIAN'),
    HEAD_TELLER: await relief(applicationPool, desk, 'relief.coord@demo-bank.example', 'Relief Coordinator', 'TELL-0902', 'R.K.', 'HEAD_TELLER_COORDINATOR'),
  };
  const captured = await captureHandover(applicationPool, {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    effectiveDate: MONDAY,
    at: TAKEN_AT,
    posts: postsFor(incoming),
  });
  const byClass = Object.fromEntries(captured.narrations.map((item) => [item.book_class, item.narration_text]));
  assert.equal(byClass.KWACHA_TREASURY, KWACHA_NARRATION);
  assert.equal(byClass.FOREIGN_CURRENCY, FOREIGN_NARRATION);
  assert.equal(byClass.BANCS_TREASURY, BANCS_NARRATION);
  assert.equal(captured.narrations.every((item) => !item.narration_text.includes('Relief Coordinator')), true);
  assert.equal(captured.narrations.every((item) => !item.narration_text.includes('TELL-0902')), true);

  const audit = await applicationPool.query(
    `SELECT detail FROM audit_events WHERE event_type = 'TAKEOVER_NARRATED'`,
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].detail.narrations.length, 3);

  const { carryForwardBranch } = require('../services/carry');
  await carryForwardBranch(applicationPool, desk.tenantId, desk.branchId, TAKEN_AT, {
    holidays: [],
    timeZone: 'Africa/Lusaka',
    dayStart: '08:00',
  });
  const monday = await applicationPool.query(
    `SELECT book_id FROM branch_vault_books
     WHERE branch_id = $1 AND book_class = 'KWACHA_TREASURY' AND business_date = $2`,
    [desk.branchId, MONDAY],
  );
  const view = await getBookView(applicationPool, desk.tenantId, monday.rows[0].book_id);
  assert.equal(view.rows[0].accounting_label, 'Bal b/f');
  assert.equal(view.rows.length, 1);
  assert.equal(view.narration.text, KWACHA_NARRATION);
  const lines = await applicationPool.query(
    `SELECT COUNT(*)::int AS n FROM vault_denomination_matrix_ledger WHERE book_id = $1`,
    [monday.rows[0].book_id],
  );
  assert.equal(lines.rows[0].n, 1);
});

test('setup and a refused or head-teller-only handover write no narration', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await lockSample(applicationPool, desk);
  const incoming = {
    CUSTODIAN_ONE: await relief(applicationPool, desk, 'relief.one@demo-bank.example', 'Relief Custodian', 'CUST-0301', 'R.C.', 'VAULT_CUSTODIAN'),
    CUSTODIAN_TWO: await relief(applicationPool, desk, 'relief.two@demo-bank.example', 'Second Relief Custodian', 'CUST-0302', 'S.R.', 'VAULT_CUSTODIAN'),
    HEAD_TELLER: await relief(applicationPool, desk, 'relief.coord@demo-bank.example', 'Relief Coordinator', 'TELL-0902', 'R.K.', 'HEAD_TELLER_COORDINATOR'),
  };
  const refused = postsFor(incoming);
  refused[0].outgoingPin = '000000';
  await assert.rejects(
    () => captureHandover(applicationPool, {
      tenantId: desk.tenantId,
      branchId: desk.branchId,
      effectiveDate: MONDAY,
      at: TAKEN_AT,
      posts: refused,
    }),
    (error) => error instanceof VaultError && error.code === 'WRONG_PIN',
  );
  const afterRefusal = await applicationPool.query(`SELECT COUNT(*)::int AS n FROM book_narrations`);
  assert.equal(afterRefusal.rows[0].n, 0);
  const refusedAudit = await applicationPool.query(
    `SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type = 'TAKEOVER_NARRATED'`,
  );
  assert.equal(refusedAudit.rows[0].n, 0);

  await applicationPool.query(
    `UPDATE post_assignments
     SET period_end = '2026-10-18'
     WHERE branch_id = $1 AND post_code IN ('CUSTODIAN_ONE', 'CUSTODIAN_TWO')`,
    [desk.branchId],
  );
  const headOnly = await captureHandover(applicationPool, {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    effectiveDate: MONDAY,
    at: TAKEN_AT,
    posts: postsFor({ HEAD_TELLER: incoming.HEAD_TELLER }),
  });
  assert.deepEqual(headOnly.narrations, []);
  const narrations = await applicationPool.query(`SELECT COUNT(*)::int AS n FROM book_narrations`);
  assert.equal(narrations.rows[0].n, 0);
});

test('a surprise cash check matches or names the difference without moving a balance', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const auditor = await relief(
    applicationPool, desk, 'auditor.desk@demo-bank.example', 'Branch Auditor', 'AUD-0012', 'A.U.', 'AUDITOR',
  );
  const checker = {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    userId: auditor.user_id,
    role: 'AUDITOR',
    email: auditor.work_email,
    fullLegalName: auditor.full_legal_name,
    employeeId: auditor.employee_id,
  };
  const custodian = {
    ...checker,
    userId: desk.users.c1.user_id,
    role: 'VAULT_CUSTODIAN',
    email: 'charles.amulike@demo-bank.example',
    fullLegalName: 'Charles Amulike',
    employeeId: 'CUST-0149',
  };
  const openViews = {};
  for (const bookClass of ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY']) {
    openViews[bookClass] = await getBookView(applicationPool, desk.tenantId, desk.books[bookClass]);
  }
  function countedFrom(view, patch = {}) {
    const counted = {};
    for (const [currency, value] of Object.entries(view.position)) {
      if (currency === 'error') continue;
      counted[currency] = value.decimal;
    }
    return { ...counted, ...patch };
  }
  const before = await ledgerFingerprint(applicationPool);
  const matched = await recordSurpriseCheck(applicationPool, checker, {
    checked_at: '2026-10-03T12:30:00.000Z',
    business_date: DATE,
    books: ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY'].map((bookClass) => ({
      book_class: bookClass,
      counted: countedFrom(openViews[bookClass]),
    })),
  });
  const who = 'Branch Auditor, AUD-0012';
  const kwacha = matched.books.find((book) => book.book_class === 'KWACHA_TREASURY');
  assert.equal(kwacha.matched, true);
  assert.equal(
    kwacha.narration_text,
    `Surprise cash check was done and found to be correct as "ZMW 1,656,515.00" "(one million six hundred and fifty-six thousand five hundred and fifteen kwacha and zero ngwee)" by "${who}" on "03/10/2026 14:30". All pages checks correctly and intact. "${who}".`,
  );
  const foreign = matched.books.find((book) => book.book_class === 'FOREIGN_CURRENCY');
  assert.equal(
    foreign.narration_text,
    `Surprise cash check was done and found to be correct as "EUR 0.00" "(zero euro)", "GBP 0.00" "(zero pounds)", "USD 8,000.00" "(eight thousand dollars)", "ZAR 25,000.00" "(twenty-five thousand rand)" by "${who}" on "03/10/2026 14:30". All pages checks correctly and intact. "${who}".`,
  );
  assert.deepEqual(await ledgerFingerprint(applicationPool), before);
  assert.equal(matched.custodians_present.map((person) => person.employeeId).join(','), 'CUST-0149,CUST-0288');

  await lockSample(applicationPool, desk);
  const mismatched = await recordSurpriseCheck(applicationPool, checker, {
    checked_at: '2026-10-07T06:15:00.000Z',
    business_date: DATE,
    books: [
      { book_class: 'KWACHA_TREASURY', counted: countedFrom(openViews.KWACHA_TREASURY) },
      { book_class: 'FOREIGN_CURRENCY', counted: countedFrom(openViews.FOREIGN_CURRENCY, { USD: '8100.00' }) },
      { book_class: 'BANCS_TREASURY', counted: countedFrom(openViews.BANCS_TREASURY, { EUR: '1400.00' }) },
    ],
  });
  const late = '07/10/2026 08:15';
  const bancs = mismatched.books.find((book) => book.book_class === 'BANCS_TREASURY');
  const foreignDiff = mismatched.books.find((book) => book.book_class === 'FOREIGN_CURRENCY');
  const kwachaStill = mismatched.books.find((book) => book.book_class === 'KWACHA_TREASURY');
  assert.equal(bancs.matched, false);
  assert.equal(foreignDiff.matched, false);
  assert.equal(kwachaStill.matched, true);
  assert.equal(
    bancs.narration_text,
    `Surprise cash check was done and found to be short by "EUR 100.00" "(one hundred euro)" by "${who}" on "${late}". All pages checks correctly and intact. "${who}".`,
  );
  assert.equal(
    foreignDiff.narration_text,
    `Surprise cash check was done and found to be over by "USD 100.00" "(one hundred dollars)" by "${who}" on "${late}". All pages checks correctly and intact. "${who}".`,
  );
  assert.match(kwachaStill.narration_text, /found to be correct as "ZMW 1,656,515.00"/);
  assert.deepEqual(await ledgerFingerprint(applicationPool), before);

  const evening = await recordSurpriseCheck(applicationPool, checker, {
    checked_at: '2026-10-03T21:40:00.000Z',
    books: ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY'].map((bookClass) => ({
      book_class: bookClass,
      counted: countedFrom(openViews[bookClass]),
    })),
  });
  assert.equal(evening.checked_at_display, '03/10/2026 23:40');
  assert.equal(evening.books.every((book) => book.matched), true);
  assert.deepEqual(await ledgerFingerprint(applicationPool), before);

  await assert.rejects(
    () => recordSurpriseCheck(applicationPool, custodian, {
      checked_at: '2026-10-03T12:00:00.000Z',
      books: [],
    }),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );
});

test('In or Out is In, Out, CIT In, and CIT Out, and Bal c/d does not wait for In Vault', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const options = await listMovementOptions(applicationPool, desk.tenantId);
  assert.deepEqual(options.filter((option) => option.is_active).map((option) => option.label), [
    'In', 'Out', 'CIT In', 'CIT Out',
  ]);
  assert.equal(options.some((option) => option.label === 'Out ATM' && option.is_active), false);

  const admin = { email: 'admin@demo-bank.example', tenantId: desk.tenantId, actorUserId: null };
  const added = await addMovementOption(applicationPool, admin, {
    label: 'In Night Safe',
    flow_direction: 'IN',
  });
  assert.equal(added.label, 'In Night Safe');
  assert.equal(require('../services/movements').updateMovementOption, undefined);
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const deskSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const deskHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.equal(serverSource.includes('/api/movement-options/:optionId'), false);
  assert.equal(deskHtml.includes('movement-list'), false);
  assert.equal(deskSource.includes("textContent = 'Rename'"), false);
  assert.equal(deskSource.includes("textContent = option.is_active ? 'Retire' : 'Restore'"), false);

  await applicationPool.query(
    `INSERT INTO movement_options (tenant_id, label, flow_direction, carries_down, sort_order, is_active)
     VALUES ($1, 'Out ATM', 'OUT', false, 1, true)`,
    [desk.tenantId],
  );
  const renamedBook = await createBookWithRows(applicationPool, {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    bookClass: 'KWACHA_TREASURY',
    businessDate: '2026-10-07',
    rows: [kwachaRows[0]],
    mirrorCore: false,
  });
  await insertLedgerRow(applicationPool, {
    tenantId: desk.tenantId,
    bookId: renamedBook,
    transactionDate: '2026-10-07',
    custodianOneInitials: 'C.A.',
    custodianTwoInitials: 'J.P.',
    tellerCoordInitials: 'M.K.',
    accountingLabel: 'Out ATM',
    flowDirection: 'OUT',
    amounts: { REISSUABLE: { K10: '10.00' } },
  });
  const healed = await listMovementOptions(applicationPool, desk.tenantId);
  assert.deepEqual(healed.filter((option) => option.is_active).map((option) => option.label), [
    'In', 'Out', 'CIT In', 'CIT Out', 'In Night Safe',
  ]);
  assert.equal(healed.find((option) => option.label === 'Out ATM').is_active, false);
  assert.ok(healed.find((option) => option.label === 'In Night Safe').sort_order > 4);
  const kept = await applicationPool.query(
    `SELECT accounting_label FROM vault_denomination_matrix_ledger
     WHERE book_id = $1 AND accounting_label = 'Out ATM'`,
    [renamedBook],
  );
  assert.equal(kept.rowCount, 1);

  await assert.rejects(
    () => addMovementOption(applicationPool, {
      email: 'charles.amulike@demo-bank.example',
      tenantId: desk.tenantId,
    }, { label: 'Out Side Door', flow_direction: 'OUT' }),
    (error) => error instanceof VaultError && error.code === 'WRONG_ROLE',
  );

  const bookId = await createBookWithRows(applicationPool, {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    bookClass: 'KWACHA_TREASURY',
    businessDate: '2026-10-06',
    rows: [kwachaRows[0]],
    mirrorCore: false,
  });
  const initials = {
    tenantId: desk.tenantId,
    bookId,
    custodianOneInitials: 'C.A.',
    custodianTwoInitials: 'J.P.',
    tellerCoordInitials: 'M.K.',
  };
  const squared = await writeCarriedDown(applicationPool, initials);
  const view = await getBookView(applicationPool, desk.tenantId, bookId);
  assert.equal(view.rows.at(-1).accounting_label, 'Bal c/d');
  assert.equal(view.rows.at(-1).line_number, squared.lineNumber);
  assert.equal(view.rows.some((row) => row.accounting_label === 'In Vault'), false);
  assert.equal(view.rows[0].in_or_out, 'Bal b/f');
});
