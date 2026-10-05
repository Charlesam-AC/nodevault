const test = require('node:test');
const assert = require('node:assert/strict');
const { getLayout, publicLayout, listBookClasses } = require('../services/layout');

function headers(bookClass) {
  return getLayout(bookClass).columns.map((column) => column.header);
}

function spreadHeaders(bookClass) {
  return publicLayout(bookClass).groups.flatMap((group) => group.columns.map((column) => column.header));
}

test('a branch has exactly three treasury book classes', () => {
  assert.deepEqual(listBookClasses(), [
    'KWACHA_TREASURY',
    'FOREIGN_CURRENCY',
    'BANCS_TREASURY',
  ]);
  assert.equal(getLayout('KWACHA_TREASURY').title, 'Kwacha Treasury Book');
  assert.equal(getLayout('FOREIGN_CURRENCY').title, 'Foreign Currency Treasury Book');
  assert.equal(getLayout('BANCS_TREASURY').title, 'Bancs Treasury Book');
  assert.equal(
    getLayout('FOREIGN_CURRENCY').sheetTitle,
    'FOREIGN NOTES (all currencies to be squared off after transaction)',
  );
  assert.equal(getLayout('BANCS_TREASURY').sheetTitle, getLayout('FOREIGN_CURRENCY').sheetTitle);
  assert.match(getLayout('KWACHA_TREASURY').sheetTitle, /^KWACHA NOTES /);
});

test('foreign currency and bancs share one column layout', () => {
  const foreign = getLayout('FOREIGN_CURRENCY');
  const bancs = getLayout('BANCS_TREASURY');
  assert.deepEqual(
    foreign.columns.map(({ header, channel, code, kind, page }) => ({ header, channel, code, kind, page })),
    bancs.columns.map(({ header, channel, code, kind, page }) => ({ header, channel, code, kind, page })),
  );
  assert.equal(foreign.grandCurrency, null);
  assert.equal(bancs.grandCurrency, null);
  const labels = headers('FOREIGN_CURRENCY');
  assert.deepEqual(labels.slice(0, 8), [
    'EUR 500', 'EUR 200', 'EUR 100', 'EUR 50', 'EUR 20', 'EUR 10', 'EUR 5', 'TOTAL EUR',
  ]);
  assert.ok(labels.includes('GBP 50') && labels.includes('TOTAL GBP'));
  assert.ok(labels.includes('USD 2') && labels.includes('TOTAL USD'));
  assert.ok(labels.includes('ZAR 200') && labels.includes('TOTAL ZAR'));
  assert.equal(labels.some((label) => /grand total/i.test(label)), false);
});

test('kwacha layout is notes, re-issuable, coins, and grand total, with no old currency column', () => {
  const labels = headers('KWACHA_TREASURY');
  assert.ok(labels.includes('K500') && labels.includes('K10'));
  assert.ok(labels.includes('Total Re-Issuable'));
  assert.ok(labels.includes('K5') && labels.includes('5n'));
  assert.ok(labels.includes('Total Coins'));
  assert.ok(labels.includes('Grand Total'));
  assert.equal(labels.some((label) => /old currency/i.test(label)), false);
  assert.equal(getLayout('KWACHA_TREASURY').formula, 'Grand Total = Total Re-Issuable + Total Coins');
  const spread = spreadHeaders('KWACHA_TREASURY');
  assert.equal(spread[0], 'No.');
  assert.equal(spread.at(-1), 'No.');
  assert.ok(spread.includes('In or Out'));
  assert.ok(spread.includes('Initials'));
  assert.equal(spreadHeaders('BANCS_TREASURY').at(-1), 'No.');
  assert.equal(spreadHeaders('FOREIGN_CURRENCY').at(-1), 'No.');
});
