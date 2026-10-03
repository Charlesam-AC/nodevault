// Sample rows from the v1.0.4 specification, placed on the paper-book columns.
// The photographed Kwacha sheet has more denomination columns than the PDF
// table image showed. Cells the PDF did not print are filled so the published
// subtotals still hold:
//   Bal b/f re-issuable remainder 90,000 = K50 50,000 + K20 30,000 + K10 10,000
//   Bal b/f coins remainder 2,650 = K2 2,000 + 50n 500 + 10n 100 + 5n 50
//   Bal b/d re-issuable remainder 17,000 = K50 10,000 + K20 5,000 + K10 2,000
//   Bal b/d coins remainder 265 = K2 200 + 50n 50 + 10n 10 + 5n 5
// Non-re-issuable notes are zero in the sample. They are not part of Total Treasury.
// Foreign totals use ZAR and USD. EUR, GBP, and the extra USD/ZAR denominations are zero.

const DATE = '2026-10-03';
const INITIALS = {
  custodianOneInitials: 'C.A.',
  custodianTwoInitials: 'J.P.',
  tellerCoordInitials: 'M.K.',
};

const SAMPLE_TOTALS = {
  kwacha: { decimal: '1656515.00', display: 'K1,656,515.00' },
  zar: { decimal: '25000.00', display: 'R25,000.00' },
  usd: { decimal: '8000.00', display: '$8,000.00' },
};

function row(label, flow, amounts) {
  return {
    transactionDate: DATE,
    ...INITIALS,
    accountingLabel: label,
    flowDirection: flow,
    amounts,
  };
}

const kwachaRows = [
  row('Bal b/f', 'BAL', {
    REISSUABLE: {
      K500: '500000.00',
      K200: '200000.00',
      K100: '100000.00',
      K50: '50000.00',
      K20: '30000.00',
      K10: '10000.00',
    },
    COINS: {
      K5: '5000.00',
      K2: '2000.00',
      K1: '1000.00',
      '50n': '500.00',
      '10n': '100.00',
      '5n': '50.00',
    },
  }),
  row('CIT_IN', 'IN', {
    REISSUABLE: {
      K500: '500000.00',
      K200: '0.00',
      K100: '200000.00',
    },
  }),
  row('Bal b/d', 'IN', {
    REISSUABLE: {
      K500: '0.00',
      K200: '40000.00',
      K100: '0.00',
      K50: '10000.00',
      K20: '5000.00',
      K10: '2000.00',
    },
    COINS: {
      K5: '500.00',
      K2: '200.00',
      K1: '100.00',
      '50n': '50.00',
      '10n': '10.00',
      '5n': '5.00',
    },
  }),
  row('Bal c/d', 'BAL', {
    REISSUABLE: {
      K500: '1000000.00',
      K200: '240000.00',
      K100: '300000.00',
      K50: '60000.00',
      K20: '35000.00',
      K10: '12000.00',
    },
    COINS: {
      K5: '5500.00',
      K2: '2200.00',
      K1: '1100.00',
      '50n': '550.00',
      '10n': '110.00',
      '5n': '55.00',
    },
  }),
];

const foreignRows = [
  row('Bal b/f', 'BAL', {
    ZAR: { '200': '10000.00', '100': '5000.00' },
    USD: { '100': '4000.00', '50': '2000.00' },
  }),
  row('CIT_IN', 'IN', {
    USD: { '100': '1500.00', '50': '0.00' },
  }),
  row('Bal b/d', 'IN', {
    ZAR: { '200': '10000.00', '100': '0.00' },
    USD: { '100': '0.00', '50': '500.00' },
  }),
  row('Bal c/d', 'BAL', {
    ZAR: { '200': '20000.00', '100': '5000.00' },
    USD: { '100': '5500.00', '50': '2500.00' },
  }),
];

// Bancs uses the same foreign-notes columns as a separate book, with its own figures.
const bancsRows = [
  row('Bal b/f', 'BAL', {
    EUR: { '500': '1000.00' },
    GBP: { '50': '500.00' },
    USD: { '100': '200.00' },
    ZAR: { '200': '400.00' },
  }),
  row('CIT_IN', 'IN', {
    EUR: { '200': '500.00' },
    USD: { '2': '20.00' },
  }),
  row('Bal c/d', 'BAL', {
    EUR: { '500': '1000.00', '200': '500.00' },
    GBP: { '50': '500.00' },
    USD: { '100': '200.00', '2': '20.00' },
    ZAR: { '200': '400.00' },
  }),
];

const BANCS_TOTALS = {
  eur: { decimal: '1500.00', display: '€1,500.00' },
  gbp: { decimal: '500.00', display: '£500.00' },
  usd: { decimal: '220.00', display: '$220.00' },
  zar: { decimal: '400.00', display: 'R400.00' },
};

module.exports = {
  DATE,
  INITIALS,
  SAMPLE_TOTALS,
  BANCS_TOTALS,
  kwachaRows,
  foreignRows,
  bancsRows,
};
