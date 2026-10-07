const test = require('node:test');
const assert = require('node:assert/strict');
const { toMinor, formatMoney } = require('../services/money');
const { composeRow, presentRows, rollForward, positionByCurrency, getBookView } = require('../services/ledger');
const { parseOutstanding } = require('../services/corebank');
const {
  SAMPLE_TOTALS,
  BANCS_TOTALS,
  kwachaRows,
  foreignRows,
  bancsRows,
} = require('../fixtures/sampleLedger');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');
const bcrypt = require('bcryptjs');

function positionOf(bookClass, rows) {
  const built = rows.map((row) => ({
    ...row,
    cells: composeRow(bookClass, row),
  }));
  rollForward(built);
  const carried = built[built.length - 1];
  return positionByCurrency(bookClass, carried.cells);
}

test('an Out total prints a minus and an In total prints a plus', () => {
  assert.equal(formatMoney(1000n, 'K', { signed: true }), '+ K10.00');
  assert.equal(formatMoney(1000n, 'K', { signed: true, direction: 'OUT' }), '- K10.00');
  assert.equal(formatMoney(0n, 'K', { signed: true, direction: 'OUT' }), '- K0.00');
  assert.equal(formatMoney(1000n, 'K'), 'K10.00');
  const cells = composeRow('KWACHA_TREASURY', {
    amounts: { REISSUABLE: { K100: '10.00' } },
  });
  const base = {
    lineNumber: 2,
    transactionDate: '2026-10-07',
    custodianOneInitials: 'C.A.',
    custodianTwoInitials: 'J.P.',
    tellerCoordInitials: 'M.K.',
    lineReference: 'Seal 14',
    cells,
  };
  const [incoming] = presentRows('KWACHA_TREASURY', [{
    ...base,
    flowDirection: 'IN',
    accountingLabel: 'CIT In',
  }]);
  const [outgoing] = presentRows('KWACHA_TREASURY', [{
    ...base,
    flowDirection: 'OUT',
    accountingLabel: 'CIT Out',
  }]);
  assert.equal(incoming.displays['REISSUABLE|K100|DENOMINATION'], 'K10.00');
  assert.equal(outgoing.displays['REISSUABLE|K100|DENOMINATION'], 'K10.00');
  assert.equal(incoming.displays['REISSUABLE|TOTAL|SUBTOTAL'], '+ K10.00');
  assert.equal(outgoing.displays['REISSUABLE|TOTAL|SUBTOTAL'], '- K10.00');
  assert.equal(incoming.displays['TREASURY|GRAND|GRAND'], '+ K10.00');
  assert.equal(outgoing.displays['TREASURY|GRAND|GRAND'], '- K10.00');
  assert.equal(incoming.displays['COINS|TOTAL|SUBTOTAL'], '+ K0.00');
  assert.equal(outgoing.displays['COINS|TOTAL|SUBTOTAL'], '- K0.00');
});

test('minor units stay exact where binary floats do not', () => {
  assert.equal(toMinor('0.10') + toMinor('0.20'), toMinor('0.30'));
  assert.equal(toMinor('9007199254740993.01'), 900719925474099301n);
  assert.throws(() => toMinor(0.1), /decimal strings/);
  assert.throws(() => parseOutstanding({ outstanding: { ZMW: 1656515 } }), /decimal strings/);
  assert.equal(parseOutstanding({ outstanding: { ZMW: '1656515.00' } }).ZMW, 165651500n);
});

test('sample rows hit the published Kwacha, ZAR, and USD totals', () => {
  const kwacha = positionOf('KWACHA_TREASURY', kwachaRows);
  assert.equal(formatMoney(kwacha.ZMW, 'K'), SAMPLE_TOTALS.kwacha.display);
  const foreign = positionOf('FOREIGN_CURRENCY', foreignRows);
  assert.equal(formatMoney(foreign.ZAR, 'R'), SAMPLE_TOTALS.zar.display);
  assert.equal(formatMoney(foreign.USD, '$'), SAMPLE_TOTALS.usd.display);
  assert.equal(foreign.EUR, 0n);
  assert.equal(foreign.GBP, 0n);
  const bancs = positionOf('BANCS_TREASURY', bancsRows);
  assert.equal(formatMoney(bancs.EUR, '€'), BANCS_TOTALS.eur.display);
  assert.equal(formatMoney(bancs.GBP, '£'), BANCS_TOTALS.gbp.display);
  assert.equal(formatMoney(bancs.USD, '$'), BANCS_TOTALS.usd.display);
  assert.equal(formatMoney(bancs.ZAR, 'R'), BANCS_TOTALS.zar.display);
});

test('non-re-issuable notes do not enter the Kwacha grand total', () => {
  const [opening] = kwachaRows;
  const withUnfit = {
    ...opening,
    amounts: {
      ...opening.amounts,
      UNFIT: { K100: '100.00' },
    },
  };
  const plain = composeRow('KWACHA_TREASURY', opening);
  const dirty = composeRow('KWACHA_TREASURY', withUnfit);
  const grand = (cells) => cells.find((cell) => cell.kind === 'GRAND').amountMinor;
  assert.equal(grand(plain), grand(dirty));
  assert.equal(formatMoney(grand(dirty), 'K'), 'K898,650.00');
});

test('each of the three books can be opened and keeps its own position', async () => {
  await setupPools();
  await resetDatabase();
  const pinHash = await bcrypt.hash('135790', 6);
  const desk = await createDesk(pinHash);
  const { applicationPool } = pools();
  const classes = Object.keys(desk.books);
  assert.deepEqual(classes.sort(), ['BANCS_TREASURY', 'FOREIGN_CURRENCY', 'KWACHA_TREASURY']);
  const kwacha = await getBookView(applicationPool, desk.tenantId, desk.books.KWACHA_TREASURY);
  const foreign = await getBookView(applicationPool, desk.tenantId, desk.books.FOREIGN_CURRENCY);
  const bancs = await getBookView(applicationPool, desk.tenantId, desk.books.BANCS_TREASURY);
  assert.equal(kwacha.layout.title, 'Kwacha Treasury Book');
  assert.equal(foreign.layout.title, 'Foreign Currency Treasury Book');
  assert.equal(bancs.layout.title, 'Bancs Treasury Book');
  assert.equal(kwacha.position.ZMW.display, 'K1,656,515.00');
  assert.equal(foreign.position.ZAR.display, 'R25,000.00');
  assert.equal(foreign.position.USD.display, '$8,000.00');
  assert.equal(bancs.position.EUR.display, '€1,500.00');
  assert.equal(bancs.position.USD.decimal, '220.00');
  assert.notEqual(foreign.position.USD.decimal, bancs.position.USD.decimal);
  const foreignHeaders = foreign.layout.groups.flatMap((group) => group.columns.map((column) => column.header));
  const bancsHeaders = bancs.layout.groups.flatMap((group) => group.columns.map((column) => column.header));
  assert.deepEqual(foreignHeaders, bancsHeaders);
  await closePools();
});
