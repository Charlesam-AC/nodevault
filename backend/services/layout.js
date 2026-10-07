// Paper-book column catalogue.
// Foreign Notes follows the photographed spread (EUR, GBP | USD, ZAR).
// Kwacha follows the photographed spread with Old Currency Notes (B) omitted.
// Total Treasury = Total Re-Issuable Notes (A) + Total Coins (C).
// Foreign Currency and Bancs share one layout builder.

const IDENTITY = [
  { key: 'line_number', header: 'No.' },
  { key: 'date', header: 'Date' },
  { key: 'in_or_out', header: 'In or Out' },
  { key: 'initials', header: 'Initials' },
];

function amountColumn(spec) {
  return {
    page: spec.page,
    group: spec.group,
    groupLabel: spec.groupLabel,
    channel: spec.channel,
    code: spec.code,
    header: spec.header,
    kind: spec.kind,
    currency: spec.currency,
    symbol: spec.symbol,
    inGrand: Boolean(spec.inGrand),
  };
}

function denominations(page, group, groupLabel, channel, currency, symbol, items) {
  return items.map(([code, header]) => amountColumn({
    page,
    group,
    groupLabel,
    channel,
    code,
    header,
    kind: 'DENOMINATION',
    currency,
    symbol,
    inGrand: false,
  }));
}

function subtotal(page, group, groupLabel, channel, header, currency, symbol, inGrand) {
  return amountColumn({
    page,
    group,
    groupLabel,
    channel,
    code: 'TOTAL',
    header,
    kind: 'SUBTOTAL',
    currency,
    symbol,
    inGrand,
  });
}

function kwachaLayout() {
  const reissuableLabel = 'Re-Issuable Notes';
  const unfitLabel = 'Non-Re-Issuable Notes';
  const coinsLabel = 'Coins';
  const columns = [
    ...denominations('LEFT', 'REISSUABLE', reissuableLabel, 'REISSUABLE', 'ZMW', 'K', [
      ['K500', 'K500'],
      ['K200', 'K200'],
      ['K100', 'K100'],
      ['K50', 'K50'],
      ['K20', 'K20'],
      ['K10', 'K10'],
    ]),
    subtotal('LEFT', 'REISSUABLE', reissuableLabel, 'REISSUABLE', 'Total Re-Issuable', 'ZMW', 'K', true),
    ...denominations('RIGHT', 'UNFIT', unfitLabel, 'UNFIT', 'ZMW', 'K', [
      ['K100', 'K100'],
      ['K50', 'K50'],
      ['K20', 'K20'],
      ['K10', 'K10'],
      ['K5', 'K5'],
      ['K2', 'K2'],
    ]),
    ...denominations('RIGHT', 'COINS', coinsLabel, 'COINS', 'ZMW', 'K', [
      ['K5', 'K5'],
      ['K2', 'K2'],
      ['K1', 'K1'],
      ['50n', '50n'],
      ['10n', '10n'],
      ['5n', '5n'],
    ]),
    subtotal('RIGHT', 'COINS', coinsLabel, 'COINS', 'Total Coins', 'ZMW', 'K', true),
    amountColumn({
      page: 'RIGHT',
      group: 'TREASURY',
      groupLabel: 'Treasury',
      channel: 'TREASURY',
      code: 'GRAND',
      header: 'Grand Total',
      kind: 'GRAND',
      currency: 'ZMW',
      symbol: 'K',
      inGrand: false,
    }),
  ];
  return {
    bookClass: 'KWACHA_TREASURY',
    title: 'Kwacha Treasury Book',
    sheetTitle: 'KWACHA NOTES (all denominations to be squared off after transaction)',
    instruction: 'Square off all denominations after any transaction',
    formula: 'Grand Total = Total Re-Issuable + Total Coins',
    grandCurrency: 'ZMW',
    columns,
  };
}

function foreignColumns() {
  const euro = 'EURO NOTES';
  const sterling = 'GBP NOTES';
  const dollar = 'USD NOTES';
  const rand = 'ZAR NOTES';
  return [
    ...denominations('LEFT', 'EUR', euro, 'EUR', 'EUR', '€', [
      ['500', 'EUR 500'],
      ['200', 'EUR 200'],
      ['100', 'EUR 100'],
      ['50', 'EUR 50'],
      ['20', 'EUR 20'],
      ['10', 'EUR 10'],
      ['5', 'EUR 5'],
    ]),
    subtotal('LEFT', 'EUR', euro, 'EUR', 'TOTAL EUR', 'EUR', '€', false),
    ...denominations('LEFT', 'GBP', sterling, 'GBP', 'GBP', '£', [
      ['50', 'GBP 50'],
      ['20', 'GBP 20'],
      ['10', 'GBP 10'],
      ['5', 'GBP 5'],
    ]),
    subtotal('LEFT', 'GBP', sterling, 'GBP', 'TOTAL GBP', 'GBP', '£', false),
    ...denominations('RIGHT', 'USD', dollar, 'USD', 'USD', '$', [
      ['100', 'USD 100'],
      ['50', 'USD 50'],
      ['20', 'USD 20'],
      ['10', 'USD 10'],
      ['5', 'USD 5'],
      ['2', 'USD 2'],
      ['1', 'USD 1'],
    ]),
    subtotal('RIGHT', 'USD', dollar, 'USD', 'TOTAL USD', 'USD', '$', false),
    ...denominations('RIGHT', 'ZAR', rand, 'ZAR', 'ZAR', 'R', [
      ['200', 'ZAR 200'],
      ['100', 'ZAR 100'],
      ['50', 'ZAR 50'],
      ['20', 'ZAR 20'],
      ['10', 'ZAR 10'],
    ]),
    subtotal('RIGHT', 'ZAR', rand, 'ZAR', 'TOTAL ZAR', 'ZAR', 'R', false),
  ];
}

// Shared by the Foreign Notes book and the Bancs book.
function foreignLayout(bookClass, title) {
  return {
    bookClass,
    title,
    sheetTitle: 'FOREIGN NOTES (all currencies to be squared off after transaction)',
    instruction: 'All currencies to be squared off after any transaction',
    formula: 'Each currency totals on its own. Currencies are not added together.',
    grandCurrency: null,
    columns: foreignColumns(),
  };
}

function getLayout(bookClass) {
  if (bookClass === 'KWACHA_TREASURY') return kwachaLayout();
  if (bookClass === 'FOREIGN_CURRENCY') return foreignLayout(bookClass, 'Foreign Currency Treasury Book');
  if (bookClass === 'BANCS_TREASURY') return foreignLayout(bookClass, 'Bancs Treasury Book');
  throw new Error(`unknown book class ${bookClass}`);
}

function listBookClasses() {
  return ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY'];
}

function catalogueRows(bookClass) {
  const layout = getLayout(bookClass);
  return layout.columns.map((column, index) => ({
    book_class: bookClass,
    page_side: column.page,
    group_code: column.group,
    group_label: column.groupLabel,
    channel_code: column.channel,
    denomination_code: column.code,
    header_label: column.header,
    sort_order: index + 1,
    currency_code: column.currency,
    symbol: column.symbol,
    cell_kind: column.kind,
    in_grand: column.inGrand,
  }));
}

function publicLayout(bookClass) {
  const layout = getLayout(bookClass);
  const groups = [];
  const push = (page, group, label, column) => {
    const last = groups[groups.length - 1];
    if (!last || last.page !== page || last.id !== group) {
      groups.push({ page, id: group, label, columns: [] });
    }
    groups[groups.length - 1].columns.push(column);
  };
  for (const column of IDENTITY) {
    push('LEFT', 'IDENTITY', '', { header: column.header, key: column.key });
  }
  for (const column of layout.columns) {
    push(column.page, column.group, column.groupLabel, {
      header: column.header,
      channel: column.channel,
      code: column.code,
      kind: column.kind,
      symbol: column.symbol,
    });
  }
  return {
    book_class: bookClass,
    title: layout.title,
    sheet_title: layout.sheetTitle,
    instruction: layout.instruction,
    formula: layout.formula,
    identity: IDENTITY.map((column) => column.header),
    groups,
  };
}

module.exports = {
  IDENTITY,
  getLayout,
  listBookClasses,
  catalogueRows,
  publicLayout,
};
