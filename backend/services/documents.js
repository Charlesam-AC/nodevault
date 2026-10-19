// A4 PDFs for the five printed documents. The logo image is drawn here and nowhere on the desk.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getLayout } = require('./layout');
const { formatMoney } = require('./money');
const { presentRows } = require('./ledger');
const { formatDisplayDate } = require('./week');
const { VaultError } = require('./errors');

const A4 = {
  portrait: [595.28, 841.89],
  landscape: [841.89, 595.28],
};

const LOGO_DIR = path.join(__dirname, '..', 'assets', 'logos');
const DEFAULT_LOGO = 'fnb-acacia.png';
const MARGIN = { top: 96, bottom: 36, left: 28, right: 28 };

const BOOK_TITLE = {
  KWACHA_TREASURY: 'Kwacha Treasury Book',
  FOREIGN_CURRENCY: 'Foreign Currency Treasury Book',
  BANCS_TREASURY: 'Bancs Treasury Book',
};

const COIN_LABEL = { '50n': 'N50', '10n': 'N10', '5n': 'N5' };

function resolveLogo(fileName) {
  const requested = fileName ? String(fileName) : DEFAULT_LOGO;
  const base = path.basename(requested);
  if (base !== requested || !/^[A-Za-z0-9._-]+\.png$/.test(base)) {
    throw new VaultError('INVALID_LOGO', 'The logo file is a PNG name in the logo folder, with no path');
  }
  const full = path.join(LOGO_DIR, base);
  if (!full.startsWith(LOGO_DIR + path.sep) || !fs.existsSync(full)) {
    throw new VaultError('INVALID_LOGO', 'That logo file is not on this server');
  }
  return full;
}

function printColumns(bookClass) {
  return getLayout(bookClass).columns.filter((column) => !(
    column.channel === 'USD' && column.code === '2' && column.kind === 'DENOMINATION'
  ));
}

function columnHeading(column) {
  if (column.kind === 'GRAND') return 'TOTAL TREASURY';
  if (COIN_LABEL[column.code]) return COIN_LABEL[column.code];
  if (column.channel === 'USD' && column.kind === 'DENOMINATION') return `USD ${column.code}`;
  return column.header;
}

function isBoldColumn(column) {
  return column.kind === 'SUBTOTAL' || column.kind === 'GRAND';
}

function isBalanceRow(row) {
  return row.accountingLabel === 'Bal b/f'
    || row.accountingLabel === 'Bal b/d'
    || row.accountingLabel === 'Bal c/d';
}

function openDocument(layout) {
  const doc = new PDFDocument({
    size: A4[layout],
    margins: {
      top: MARGIN.top,
      bottom: MARGIN.bottom,
      left: MARGIN.left,
      right: MARGIN.right,
    },
    compress: false,
    autoFirstPage: true,
    info: { Title: 'NodeVault', Producer: 'NodeVault' },
  });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done, layout };
}

function paintLogo(doc, logoPath) {
  doc.image(logoPath, doc.page.margins.left, 16, { width: 63, height: 63 });
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;
}

function addSheetPage(doc, layout) {
  doc.addPage({
    size: A4[layout],
    margins: {
      top: MARGIN.top,
      bottom: MARGIN.bottom,
      left: MARGIN.left,
      right: MARGIN.right,
    },
  });
}

function ensureRoom(doc, logoPath, layout, needed) {
  if (doc.y + needed <= A4[layout][1] - MARGIN.bottom) return;
  addSheetPage(doc, layout);
}

function writeLine(doc, text, options = {}) {
  const bold = Boolean(options.bold);
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.size || 9);
  doc.fillColor('#102833');
  doc.text(String(text), options.x == null ? MARGIN.left : options.x, options.y == null ? doc.y : options.y, {
    width: options.width || (A4[options.layout || 'portrait'][0] - MARGIN.left - MARGIN.right),
    lineGap: 1,
  });
}

function signatureBand(doc, logoPath, layout, people) {
  const pageWidth = A4[layout][0];
  const usable = pageWidth - MARGIN.left - MARGIN.right;
  const each = usable / people.length;
  ensureRoom(doc, logoPath, layout, 78);
  doc.y += 14;
  const top = doc.y;
  people.forEach((person, index) => {
    const x = MARGIN.left + index * each;
    const lineY = top + 16;
    doc.save();
    doc.moveTo(x, lineY).lineTo(x + each - 14, lineY).lineWidth(0.8).strokeColor('#102833').stroke();
    doc.restore();
    doc.font('Helvetica').fontSize(8).fillColor('#102833');
    doc.text('Signature', x, lineY + 4, { width: each - 16, lineBreak: false });
    doc.text(person.full_legal_name, x, lineY + 16, { width: each - 16, lineBreak: false });
    doc.text(person.employee_id, x, lineY + 28, { width: each - 16, lineBreak: false });
    const caption = [person.initials, person.role].filter(Boolean).join(' · ');
    if (caption) doc.text(caption, x, lineY + 40, { width: each - 16, lineBreak: false });
  });
  doc.x = MARGIN.left;
  doc.y = top + 72;
}

function headingBlock(doc, logoPath, layout, lines) {
  paintLogo(doc, logoPath);
  doc.on('pageAdded', () => paintLogo(doc, logoPath));
  const width = A4[layout][0] - MARGIN.left - MARGIN.right;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#102833');
  doc.text(lines[0], MARGIN.left + 74, 22, { width: width - 74, lineBreak: false });
  let y = 42;
  doc.font('Helvetica').fontSize(9);
  for (const line of lines.slice(1)) {
    doc.text(line, MARGIN.left + 74, y, { width: width - 74 });
    y = doc.y;
  }
  doc.x = MARGIN.left;
  doc.y = Math.max(MARGIN.top, y + 8);
}

function cellText(presented, column) {
  const key = `${column.channel}|${column.code}|${column.kind}`;
  return presented.displays[key] || '';
}

async function renderClosingSheet({
  bookClass,
  operatingDate,
  branchName,
  bankName,
  rows,
  signatories,
  logoFile,
}) {
  const logoPath = resolveLogo(logoFile);
  const layout = getLayout(bookClass);
  const columns = printColumns(bookClass);
  const presented = presentRows(bookClass, rows);
  const { doc, done } = openDocument('landscape');
  headingBlock(doc, logoPath, 'landscape', [
    'Closing sheet',
    bankName,
    `${branchName} · ${layout.title} · ${formatDisplayDate(operatingDate)}`,
    layout.formula,
  ]);
  presented.forEach((row, index) => {
    const source = rows[index];
    const bold = isBalanceRow(source);
    ensureRoom(doc, logoPath, 'landscape', 32);
    writeLine(
      doc,
      `${row.line_number}  ${row.date_display}  ${row.in_or_out}  ${row.reference || ''}  ${row.initials}`,
      { bold, size: 8, layout: 'landscape' },
    );
    const figures = columns.filter((column) => !isBoldColumn(column))
      .map((column) => `${columnHeading(column)} ${cellText(row, column)}`)
      .join('   ');
    const totals = columns.filter(isBoldColumn)
      .map((column) => `${columnHeading(column)} ${cellText(row, column)}`)
      .join('   ');
    if (figures) writeLine(doc, figures, { bold, size: 7, layout: 'landscape' });
    if (totals) writeLine(doc, totals, { bold: true, size: 8, layout: 'landscape' });
  });
  writeLine(doc, 'Zero variance against the core banking position. The book is now locked.', {
    layout: 'landscape',
    size: 9,
  });
  signatureBand(doc, logoPath, 'landscape', signatories);
  doc.end();
  return done;
}

function strokePanel(doc, layout, top) {
  const width = A4[layout][0] - MARGIN.left - MARGIN.right;
  const height = Math.max(18, doc.y - top + 6);
  doc.save();
  doc.roundedRect(MARGIN.left - 4, top - 3, width + 8, height, 4)
    .lineWidth(0.7)
    .strokeColor('#9bb0b8')
    .stroke();
  doc.restore();
}

function personCaption(person) {
  return {
    full_legal_name: person.fullLegalName || person.full_legal_name,
    employee_id: person.employeeId || person.employee_id,
    initials: person.initials || person.two_letter_initials || '',
    role: person.role || '',
  };
}

async function renderTakeoverSlip({ slip, logoFile }) {
  const logoPath = resolveLogo(logoFile);
  const { doc, done } = openDocument('portrait');
  headingBlock(doc, logoPath, 'portrait', [
    'Takeover slip',
    slip.bank_name,
    `${slip.branch_name} · ${slip.taken_over_at}`,
  ]);
  for (const book of slip.books) {
    ensureRoom(doc, logoPath, 'portrait', 70);
    const top = doc.y;
    writeLine(doc, BOOK_TITLE[book.book_class] || book.book_class, { bold: true, size: 11, layout: 'portrait' });
    for (const total of book.totals) {
      writeLine(doc, `Total B/F ${total.figure}`, { bold: true, size: 10, layout: 'portrait' });
      writeLine(doc, total.words, { size: 9, layout: 'portrait' });
    }
    writeLine(doc, book.narration_text, { size: 9, layout: 'portrait' });
    strokePanel(doc, 'portrait', top);
    doc.moveDown(0.45);
  }
  const people = [
    ...slip.handing_over.map((person) => personCaption({ ...person, role: 'Handing over' })),
    ...slip.taking_over.map((person) => personCaption({ ...person, role: 'Taking over' })),
  ];
  signatureBand(doc, logoPath, 'portrait', people);
  doc.end();
  return done;
}

async function renderSurpriseSlip({ slip, logoFile }) {
  const logoPath = resolveLogo(logoFile);
  const { doc, done } = openDocument('portrait');
  headingBlock(doc, logoPath, 'portrait', [
    'Surprise cash check',
    slip.bank_name,
    `${slip.branch_name} · ${slip.checked_at_display}`,
    `${slip.checker_name}, ${slip.checker_employee_id}`,
  ]);
  const present = (slip.custodians_present || [])
    .map((person) => `${person.fullLegalName}, ${person.employeeId}`)
    .join(' and ');
  writeLine(
    doc,
    present
      ? `Custodians present: ${present}. They do not sign.`
      : 'No custodian was assigned on this date.',
    { layout: 'portrait', size: 9 },
  );
  for (const book of slip.books) {
    ensureRoom(doc, logoPath, 'portrait', 60);
    const top = doc.y;
    writeLine(doc, BOOK_TITLE[book.book_class] || book.book_class, { bold: true, size: 11, layout: 'portrait' });
    for (const item of book.system_totals || []) {
      writeLine(doc, `Book position ${item.figure}`, { bold: true, layout: 'portrait' });
    }
    for (const item of book.counted_totals || []) {
      writeLine(doc, `Counted ${item.figure}`, { bold: true, layout: 'portrait' });
    }
    writeLine(doc, book.narration_text, { size: 9, layout: 'portrait' });
    strokePanel(doc, 'portrait', top);
    doc.moveDown(0.45);
  }
  signatureBand(doc, logoPath, 'portrait', [{
    full_legal_name: slip.checker_name,
    employee_id: slip.checker_employee_id,
    role: 'Checker',
  }]);
  doc.end();
  return done;
}

function moneyText(currency, minor) {
  if (minor == null) return '';
  const symbol = { ZMW: 'K', ZAR: 'R', USD: '$', GBP: '£', EUR: '€' }[currency] || '';
  return formatMoney(BigInt(minor), symbol);
}

async function renderAuditSheet({ review, logoFile }) {
  const logoPath = resolveLogo(logoFile);
  const { doc, done } = openDocument('portrait');
  headingBlock(doc, logoPath, 'portrait', [
    'Audit sheet',
    review.bank_name,
    `${review.branch_name} · ${review.range_from_display} to ${review.range_to_display}`,
  ]);
  writeLine(doc, 'End of audit', { bold: true, size: 11, layout: 'portrait' });
  writeLine(doc, review.end_comment, { size: 9, layout: 'portrait' });
  doc.moveDown(0.3);
  writeLine(doc, 'Physical count, book position, and core outstanding', { bold: true, size: 10, layout: 'portrait' });
  for (const row of review.totals) {
    const physical = row.physical_minor == null ? '' : moneyText(row.currency, row.physical_minor);
    const book = row.book_minor == null ? '' : moneyText(row.currency, row.book_minor);
    const core = row.core_minor == null ? '' : moneyText(row.currency, row.core_minor);
    writeLine(
      doc,
      `${row.book_title} ${row.currency}    Physical ${physical || '—'}    Book ${book || '—'}    Core ${core || '—'}`,
      { size: 8, layout: 'portrait', bold: true },
    );
  }
  doc.moveDown(0.3);
  writeLine(doc, 'Lines with a comment', { bold: true, size: 10, layout: 'portrait' });
  if (!review.commented_lines.length) {
    writeLine(doc, 'None.', { size: 9, layout: 'portrait' });
  }
  for (const line of review.commented_lines) {
    writeLine(
      doc,
      `${line.book_title} line ${line.line_number} ${line.date_display} ${line.mark_status} ${line.comment}`,
      { size: 8, layout: 'portrait' },
    );
  }
  doc.moveDown(0.3);
  writeLine(doc, 'Core transactions with no book line', { bold: true, size: 10, layout: 'portrait' });
  if (!review.core_without_book.length) {
    writeLine(doc, 'None.', { size: 9, layout: 'portrait' });
  }
  for (const tx of review.core_without_book) {
    writeLine(
      doc,
      `${tx.book_class} ${tx.business_date} ${tx.reference} ${tx.description} ${moneyText(tx.currency_code, tx.amount_minor)}`,
      { size: 8, layout: 'portrait' },
    );
  }
  writeLine(
    doc,
    `Lines marked reviewed with no comment: ${review.reviewed_without_comment}`,
    { bold: true, size: 10, layout: 'portrait' },
  );
  signatureBand(doc, logoPath, 'portrait', [{
    full_legal_name: review.auditor.full_legal_name,
    employee_id: review.auditor.employee_id,
    role: 'Auditor',
  }]);
  doc.end();
  return done;
}

function denomRows(bookClass, amounts) {
  const columns = printColumns(bookClass);
  const rows = [];
  let coinsLabelled = false;
  const totals = new Map();
  for (const column of columns) {
    if (column.kind !== 'DENOMINATION') continue;
    const raw = amounts && amounts[column.channel] && amounts[column.channel][column.code];
    const minor = raw == null || raw === '' ? 0n : require('./money').toMinor(String(raw));
    totals.set(column.channel, (totals.get(column.channel) || 0n) + minor);
    if (column.channel === 'COINS' && !coinsLabelled) {
      rows.push({ label: 'Coins', amount: '', bold: true });
      coinsLabelled = true;
    }
    rows.push({
      label: columnHeading(column),
      amount: formatMoney(minor, column.symbol),
      bold: false,
      minor,
    });
  }
  if (bookClass === 'KWACHA_TREASURY') {
    const grand = [...totals.values()].reduce((sum, value) => sum + value, 0n);
    rows.push({ label: 'TOTAL TREASURY', amount: formatMoney(grand, 'K'), bold: true, minor: grand });
  } else {
    for (const column of columns) {
      if (column.kind !== 'SUBTOTAL') continue;
      const minor = totals.get(column.channel) || 0n;
      if (column.channel === 'USD') {
        const typed = amounts && amounts.USD && amounts.USD['2'];
        const extra = typed == null || typed === '' ? 0n : require('./money').toMinor(String(typed));
        const withNote = minor + extra;
        rows.push({ label: column.header, amount: formatMoney(withNote, column.symbol), bold: true, minor: withNote });
      } else {
        rows.push({ label: column.header, amount: formatMoney(minor, column.symbol), bold: true, minor });
      }
    }
  }
  return rows;
}

function bookTotalMinor(rows) {
  const totals = rows.filter((row) => row.bold && row.label.startsWith('TOTAL'));
  if (!totals.length) return 0n;
  return totals.reduce((sum, row) => sum + (row.minor || 0n), 0n);
}

async function renderVaultSheet({ sheet, logoFile }) {
  const logoPath = resolveLogo(logoFile);
  const { doc, done } = openDocument('landscape');
  const direction = sheet.direction === 'FROM_VAULT' ? 'From Vault' : 'To Vault';
  headingBlock(doc, logoPath, 'landscape', [
    direction,
    sheet.bank_name,
    `${sheet.branch_name} · ${sheet.generated_at_display}`,
    'This sheet was generated before the vault was opened.',
  ]);
  const classes = ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY'];
  const usable = A4.landscape[0] - MARGIN.left - MARGIN.right;
  const colWidth = usable / 3;
  const startY = doc.y;
  let lowest = startY;
  classes.forEach((bookClass, index) => {
    const x = MARGIN.left + index * colWidth;
    let y = startY;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#102833');
    doc.text(BOOK_TITLE[bookClass], x, y, { width: colWidth - 10 });
    y = doc.y + 4;
    const rows = denomRows(bookClass, sheet.amounts[bookClass] || {});
    for (const row of rows) {
      doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor('#102833');
      doc.text(row.label, x, y, { width: (colWidth - 12) * 0.55, lineBreak: false });
      doc.text(row.amount, x + (colWidth - 12) * 0.55, y, { width: (colWidth - 12) * 0.4, lineBreak: false });
      y += 11;
    }
    if (y > lowest) lowest = y;
  });
  doc.x = MARGIN.left;
  doc.y = lowest + 8;
  signatureBand(doc, logoPath, 'landscape', sheet.signatories);
  doc.end();
  return done;
}

module.exports = {
  A4,
  MARGIN,
  DEFAULT_LOGO,
  resolveLogo,
  printColumns,
  columnHeading,
  denomRows,
  bookTotalMinor,
  renderClosingSheet,
  renderTakeoverSlip,
  renderSurpriseSlip,
  renderAuditSheet,
  renderVaultSheet,
};
