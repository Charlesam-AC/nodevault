const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const http = require('http');
const bcrypt = require('bcryptjs');
const { executeThreePersonVaultLock, reprintClosingSheet } = require('../services/closing');
const { captureHandover, takeoverSlip, printTakeoverSlip } = require('../services/rotation');
const { recordSurpriseCheck, printSurpriseSlip } = require('../services/surprise');
const { createVaultSheet, reprintVaultSheet } = require('../services/vaultSheets');
const { deliver } = require('../services/printJobs');
const { triggerSilentPrinter } = require('../services/print');
const {
  renderTakeoverSlip,
  renderSurpriseSlip,
  renderAuditSheet,
  renderVaultSheet,
  denomRows,
  resolveLogo,
} = require('../services/documents');
const { VaultError } = require('../services/errors');
const { DATE } = require('../fixtures/sampleLedger');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

const DECLARED = {
  KWACHA_TREASURY: { ZMW: '1656515.00' },
  FOREIGN_CURRENCY: { EUR: '0.00', GBP: '0.00', USD: '8000.00', ZAR: '25000.00' },
  BANCS_TREASURY: { EUR: '1500.00', GBP: '500.00', USD: '220.00', ZAR: '400.00' },
};

let pinHash;

function decodePdfString(token) {
  if (token.startsWith('<')) {
    return Buffer.from(token.slice(1, -1), 'hex').toString('latin1');
  }
  return token.slice(1, -1).replace(/\\n/g, '\n').replace(/\\([()\\])/g, '$1');
}

function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  const parts = [];
  const chunks = raw.split(/stream\r?\n/);
  for (let index = 1; index < chunks.length; index += 1) {
    const dictionary = chunks[index - 1].slice(-240);
    if (dictionary.includes('FlateDecode')) continue;
    const body = chunks[index].split('endstream')[0];
    const shown = /\[([\s\S]*?)\]\s*TJ|\(((?:\\\)|\\\(|\\n|\\\\|[^\\)])*)\)\s*Tj/g;
    let block;
    while ((block = shown.exec(body))) {
      if (block[2] != null) {
        parts.push(decodePdfString(`(${block[2]})`));
        continue;
      }
      const piece = [];
      const token = /<([0-9A-Fa-f]+)>|\(((?:\\\)|\\\(|\\n|\\\\|[^\\)])*)\)/g;
      let match;
      while ((match = token.exec(block[1]))) {
        piece.push(match[1]
          ? Buffer.from(match[1], 'hex').toString('latin1')
          : decodePdfString(`(${match[2]})`));
      }
      parts.push(piece.join(''));
    }
  }
  return parts.join('\n');
}

function hasExactLabel(text, label) {
  return text.split('\n').some((line) => {
    if (line === label) return true;
    if (!line.startsWith(label)) return false;
    const next = line[label.length];
    return next == null || next === ' ' || next === '$' || next === 'K';
  });
}

function mediaBoxes(buffer) {
  const raw = buffer.toString('latin1');
  return [...raw.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((match) => {
    const nums = match[1].trim().split(/\s+/).map(Number);
    return [nums[2], nums[3]];
  });
}

function assertPortrait(buffer) {
  const boxes = mediaBoxes(buffer);
  assert.ok(boxes.length >= 1);
  for (const [width, height] of boxes) {
    assert.ok(Math.abs(width - 595.28) < 1, `portrait width ${width}`);
    assert.ok(Math.abs(height - 841.89) < 1, `portrait height ${height}`);
  }
}

function assertLandscape(buffer) {
  const boxes = mediaBoxes(buffer);
  assert.ok(boxes.length >= 1);
  for (const [width, height] of boxes) {
    assert.ok(Math.abs(width - 841.89) < 1, `landscape width ${width}`);
    assert.ok(Math.abs(height - 595.28) < 1, `landscape height ${height}`);
  }
}

function assertLogo(buffer) {
  const raw = buffer.toString('latin1');
  assert.match(raw, /\/Subtype\s*\/Image/);
  assert.match(raw, /\/BaseFont\s*\/Helvetica-Bold/);
}

function payload(desk, bookClass) {
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
  };
}

async function lineCount(pool) {
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM vault_denomination_matrix_ledger');
  return result.rows[0].n;
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
  process.env.PRINTER_MODE = 'stub';
  process.env.PRINT_STUB_DIR = '/tmp/nodevault-prints-test';
  process.env.CLOSE_PRINT_FAILURE = 'queue';
  fs.rmSync('/tmp/nodevault-prints-test', { recursive: true, force: true });
});

test('the placeholder logo is a real PNG and a path cannot be swapped in', () => {
  const file = resolveLogo('fnb-logo-placeholder.png');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.throws(() => resolveLogo('../init.sql'), (error) => error instanceof VaultError);
  assert.throws(() => resolveLogo('missing.png'), (error) => error.code === 'INVALID_LOGO');
});

test('printed denomination grids omit USD 2 and old currency, and keep USD 2 inside the total', () => {
  const rows = denomRows('BANCS_TREASURY', { USD: { '100': '200.00', '2': '20.00' } });
  assert.equal(rows.some((row) => row.label === 'USD 2'), false);
  assert.equal(rows.some((row) => row.label === 'USD 1'), true);
  assert.equal(rows.find((row) => row.label === 'TOTAL USD').amount, '$220.00');
  const kwacha = denomRows('KWACHA_TREASURY', { REISSUABLE: { K100: '100.00' }, COINS: { '50n': '1.00' } });
  assert.equal(kwacha.some((row) => row.label === 'N50'), true);
  assert.equal(kwacha.some((row) => /old currency/i.test(row.label)), false);
  assert.equal(kwacha.find((row) => row.label === 'TOTAL TREASURY').amount, 'K101.00');
});

test('closing, takeover, surprise, audit, and vault sheets are A4 with the right people', async () => {
  const takeover = await renderTakeoverSlip({
    logoFile: 'fnb-logo-placeholder.png',
    slip: {
      bank_name: 'Desk Bank',
      branch_name: 'Main Branch',
      taken_over_at: '05/10/2026 08:00',
      handing_over: [
        { fullLegalName: 'Charles Amulike', employeeId: 'CUST-0149', initials: 'C.A.' },
        { fullLegalName: 'Secondary Custodian', employeeId: 'CUST-0288', initials: 'J.P.' },
      ],
      taking_over: [
        { fullLegalName: 'Relief Custodian', employeeId: 'CUST-0301', initials: 'R.C.' },
        { fullLegalName: 'Second Relief Custodian', employeeId: 'CUST-0302', initials: 'S.R.' },
      ],
      books: [{
        book_class: 'KWACHA_TREASURY',
        totals: [{ figure: '1,656,515.00', words: 'one million kwacha' }],
        narration_text: 'Takeover cash check was done and found to be correct as "1,656,515.00".',
      }],
    },
  });
  assertPortrait(takeover);
  assertLogo(takeover);
  const takeoverText = pdfText(takeover);
  assert.match(takeoverText, /Charles Amulike/);
  assert.match(takeoverText, /CUST-0149/);
  assert.match(takeoverText, /CUST-0302/);
  assert.match(takeoverText, /1,656,515\.00/);
  assert.equal(takeoverText.includes('TELL-0811'), false);
  assert.equal(/head teller/i.test(takeoverText), false);
  assert.ok(takeoverText.split('Signature').length - 1 >= 4);

  const surprise = await renderSurpriseSlip({
    logoFile: 'fnb-logo-placeholder.png',
    slip: {
      bank_name: 'Desk Bank',
      branch_name: 'Main Branch',
      checked_at_display: '03/10/2026 14:30',
      checker_name: 'Branch Auditor',
      checker_employee_id: 'AUD-0012',
      custodians_present: [
        { fullLegalName: 'Charles Amulike', employeeId: 'CUST-0149' },
        { fullLegalName: 'Secondary Custodian', employeeId: 'CUST-0288' },
      ],
      books: [{
        book_class: 'KWACHA_TREASURY',
        system_totals: [{ figure: 'ZMW 1,656,515.00' }],
        counted_totals: [{ figure: 'ZMW 1,656,515.00' }],
        narration_text: 'Surprise cash check was done and found to be correct as "ZMW 1,656,515.00".',
      }],
    },
  });
  assertPortrait(surprise);
  assertLogo(surprise);
  const surpriseText = pdfText(surprise);
  assert.match(surpriseText, /Branch Auditor/);
  assert.match(surpriseText, /AUD-0012/);
  assert.match(surpriseText, /ZMW 1,656,515\.00/);
  assert.match(surpriseText, /Custodians present/);
  assert.equal(surpriseText.split('Signature').length - 1, 1);

  const audit = await renderAuditSheet({
    logoFile: 'fnb-logo-placeholder.png',
    review: {
      bank_name: 'Desk Bank',
      branch_name: 'Main Branch',
      range_from_display: '03/10/2026',
      range_to_display: '03/10/2026',
      end_comment: 'Books agree with the core.',
      totals: [{
        book_title: 'Kwacha Treasury Book',
        currency: 'ZMW',
        physical_minor: null,
        book_minor: '165651500',
        core_minor: '165651500',
      }],
      commented_lines: [{
        book_title: 'Kwacha Treasury Book',
        line_number: 2,
        date_display: '03/10/2026',
        mark_status: 'MATCHED_WITH_DIFFERENCE',
        comment: 'CIT slip short',
      }],
      core_without_book: [{
        book_class: 'KWACHA_TREASURY',
        business_date: '2026-10-03',
        reference: 'CORE-ONLY',
        description: 'Teller entry with no book line',
        currency_code: 'ZMW',
        amount_minor: '10000',
      }],
      reviewed_without_comment: 4,
      auditor: { full_legal_name: 'Branch Auditor', employee_id: 'AUD-0012' },
    },
  });
  assertPortrait(audit);
  assertLogo(audit);
  const auditText = pdfText(audit);
  assert.match(auditText, /Books agree with the core/);
  assert.match(auditText, /CIT slip short/);
  assert.match(auditText, /CORE-ONLY/);
  assert.match(auditText, /Lines marked reviewed with no comment: 4/);
  assert.match(auditText, /Branch Auditor/);
  assert.equal(auditText.split('Signature').length - 1, 1);
  assert.equal(hasExactLabel(auditText, 'USD 2'), false);

  const vault = await renderVaultSheet({
    logoFile: 'fnb-logo-placeholder.png',
    sheet: {
      direction: 'FROM_VAULT',
      bank_name: 'Desk Bank',
      branch_name: 'Main Branch',
      generated_at_display: '03/10/2026 09:00',
      amounts: {
        KWACHA_TREASURY: { REISSUABLE: { K100: '100.00' }, COINS: { '50n': '1.00' } },
        FOREIGN_CURRENCY: { USD: { '2': '20.00', '1': '5.00' } },
        BANCS_TREASURY: {},
      },
      signatories: [
        { full_legal_name: 'Charles Amulike', employee_id: 'CUST-0149', initials: 'C.A.', role: 'Custodian 1' },
        { full_legal_name: 'Secondary Custodian', employee_id: 'CUST-0288', initials: 'J.P.', role: 'Custodian 2' },
        { full_legal_name: 'Head Teller', employee_id: 'TELL-0811', initials: 'M.K.', role: 'Head teller' },
      ],
    },
  });
  assertLandscape(vault);
  assertLogo(vault);
  const vaultText = pdfText(vault);
  assert.match(vaultText, /From Vault/);
  assert.match(vaultText, /generated before the vault was opened/);
  assert.match(vaultText, /TOTAL TREASURY/);
  assert.match(vaultText, /N50/);
  assert.match(vaultText, /Charles Amulike/);
  assert.match(vaultText, /TELL-0811/);
  assert.equal(hasExactLabel(vaultText, 'USD 2'), false);
  assert.equal(hasExactLabel(vaultText, 'USD 1'), true);
  assert.match(vaultText, /TOTAL USD/);
  assert.ok(vaultText.split('Signature').length - 1 >= 3);
});

test('each branch keeps its own printer target and stub mode writes the PDF', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await applicationPool.query(
    `UPDATE branches SET printer_target = '10.1.4.20:9100' WHERE branch_id = $1`,
    [desk.branchId],
  );
  const other = await applicationPool.query(
    `INSERT INTO branches (tenant_id, branch_code, branch_name, printer_target)
     VALUES ($1, 'KT01', 'Kitwe Branch', '10.8.8.8')
     RETURNING branch_id`,
    [desk.tenantId],
  );
  const closed = await executeThreePersonVaultLock(
    desk.tenantId,
    desk.branchId,
    payload(desk, 'KWACHA_TREASURY'),
    { pool: applicationPool },
  );
  assert.equal(closed.dispatch.find((item) => item.kind === 'PRINT').status, 'SENT');
  const stored = await applicationPool.query(
    `SELECT payload FROM dispatch_outbox WHERE book_id = $1 AND kind = 'PRINT'`,
    [desk.books.KWACHA_TREASURY],
  );
  assert.equal(stored.rows[0].payload.printerTarget, '10.1.4.20:9100');
  assert.equal(stored.rows[0].payload.printerTarget.includes('Vault_Master'), false);
  const pdf = Buffer.from(stored.rows[0].payload.pdf_base64, 'base64');
  assertLandscape(pdf);
  assertLogo(pdf);
  const text = pdfText(pdf);
  assert.match(text, /Charles Amulike/);
  assert.match(text, /Secondary Custodian/);
  assert.match(text, /Head Teller/);
  assert.match(text, /CUST-0149/);
  assert.match(text, /TELL-0811/);
  assert.match(text, /TOTAL TREASURY/);
  assert.match(text, /N50/);
  assert.equal(text.includes('Old Currency'), false);
  assert.equal(hasExactLabel(text, 'USD 2'), false);
  const files = fs.readdirSync('/tmp/nodevault-prints-test');
  assert.ok(files.some((name) => name.endsWith('.pdf')));

  const kitwe = await deliver(applicationPool, {
    tenantId: desk.tenantId,
    branchId: other.rows[0].branch_id,
    documentKind: 'TAKEOVER_SLIP',
    sourceRef: 'kitwe',
    pdf,
  });
  assert.equal(kitwe.printer_target, '10.8.8.8');
  assert.equal(kitwe.status, 'SENT');
});

test('raw and IPP jobs send the PDF bytes to the branch target', async () => {
  const pdf = await renderVaultSheet({
    logoFile: 'fnb-logo-placeholder.png',
    sheet: {
      direction: 'TO_VAULT',
      bank_name: 'Desk Bank',
      branch_name: 'Main Branch',
      generated_at_display: '03/10/2026 09:00',
      amounts: { KWACHA_TREASURY: {}, FOREIGN_CURRENCY: {}, BANCS_TREASURY: {} },
      signatories: [
        { full_legal_name: 'Charles Amulike', employee_id: 'CUST-0149', role: 'Custodian 1' },
        { full_legal_name: 'Secondary Custodian', employee_id: 'CUST-0288', role: 'Custodian 2' },
        { full_legal_name: 'Head Teller', employee_id: 'TELL-0811', role: 'Head teller' },
      ],
    },
  });
  const received = [];
  let markReceived;
  const receivedJob = new Promise((resolve) => {
    markReceived = resolve;
  });
  const raw = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      received.push(Buffer.concat(chunks));
      markReceived();
    });
  });
  await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve));
  const port = raw.address().port;
  process.env.PRINTER_MODE = 'raw';
  const rawResult = await triggerSilentPrinter({
    branchId: 1,
    printerTarget: `127.0.0.1:${port}`,
    documentKind: 'VAULT_SHEET',
    pdf_base64: pdf.toString('base64'),
  });
  await receivedJob;
  raw.close();
  assert.equal(rawResult.mode, 'raw');
  assert.equal(received.length, 1);
  assert.equal(received[0].slice(0, 5).toString(), '%PDF-');

  let ippBody = null;
  const ipp = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      ippBody = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Type': 'application/ipp' });
      res.end(Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x03]));
    });
  });
  await new Promise((resolve) => ipp.listen(0, '127.0.0.1', resolve));
  process.env.PRINTER_MODE = 'ipp';
  const ippResult = await triggerSilentPrinter({
    branchId: 1,
    printerTarget: `http://127.0.0.1:${ipp.address().port}/ipp/print`,
    documentKind: 'VAULT_SHEET',
    pdf_base64: pdf.toString('base64'),
  });
  ipp.close();
  assert.equal(ippResult.mode, 'ipp');
  assert.ok(ippBody.includes(Buffer.from('%PDF-')));
  assert.ok(ippBody.includes(Buffer.from('application/pdf')));

  process.env.PRINTER_MODE = 'stub';
  await assert.rejects(
    () => triggerSilentPrinter({ branchId: 1, documentKind: 'VAULT_SHEET', pdf_base64: pdf.toString('base64') }),
    /printer_target is not set/,
  );
  await assert.rejects(
    () => triggerSilentPrinter({
      branchId: 1,
      printerTarget: 'Vault_Master_Printer_01',
      documentKind: 'VAULT_SHEET',
      pdf_base64: pdf.toString('base64'),
    }),
    /not used/,
  );
});

test('a failed closing print stays queued unless the rollback setting is on', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  const queued = await executeThreePersonVaultLock(
    desk.tenantId,
    desk.branchId,
    payload(desk, 'FOREIGN_CURRENCY'),
    {
      pool: applicationPool,
      printer: async () => { throw new Error('printer offline'); },
      mailer: async () => {},
    },
  );
  assert.equal(queued.dispatch.find((item) => item.kind === 'PRINT').status, 'FAILED');
  const status = await applicationPool.query(
    'SELECT status FROM branch_vault_books WHERE book_id = $1',
    [desk.books.FOREIGN_CURRENCY],
  );
  assert.equal(status.rows[0].status, 'BALANCED_CLOSED');
  const failed = await applicationPool.query(
    `SELECT event_type FROM audit_events WHERE book_id = $1 AND event_type = 'DISPATCH_FAILED'`,
    [desk.books.FOREIGN_CURRENCY],
  );
  assert.equal(failed.rowCount, 1);

  process.env.CLOSE_PRINT_FAILURE = 'rollback';
  await assert.rejects(
    () => executeThreePersonVaultLock(
      desk.tenantId,
      desk.branchId,
      payload(desk, 'BANCS_TREASURY'),
      {
        pool: applicationPool,
        printer: async () => { throw new Error('printer offline'); },
        mailer: async () => {},
      },
    ),
    (error) => error instanceof VaultError && error.code === 'CLOSE_REFUSED',
  );
  const rolled = await applicationPool.query(
    'SELECT status FROM branch_vault_books WHERE book_id = $1',
    [desk.books.BANCS_TREASURY],
  );
  assert.equal(rolled.rows[0].status, 'OPEN');
  const refused = await applicationPool.query(
    `SELECT detail FROM audit_events WHERE event_type = 'CLOSE_REFUSED'`,
  );
  assert.equal(refused.rowCount, 1);
  assert.equal(refused.rows[0].detail.reason, 'PRINT');
  process.env.CLOSE_PRINT_FAILURE = 'queue';
});

test('reprinting a closing sheet does not add a ledger line', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await applicationPool.query(
    `UPDATE branches SET printer_target = '10.1.4.20' WHERE branch_id = $1`,
    [desk.branchId],
  );
  await executeThreePersonVaultLock(
    desk.tenantId,
    desk.branchId,
    payload(desk, 'KWACHA_TREASURY'),
    { pool: applicationPool, printer: async () => {}, mailer: async () => {} },
  );
  const before = await lineCount(applicationPool);
  await reprintClosingSheet(applicationPool, {
    tenantId: desk.tenantId,
    bookId: desk.books.KWACHA_TREASURY,
  }, { printer: async () => {} });
  assert.equal(await lineCount(applicationPool), before);
  const sent = await applicationPool.query(
    `SELECT COUNT(*)::int AS n FROM audit_events
     WHERE book_id = $1 AND event_type = 'PRINT_SENT'`,
    [desk.books.KWACHA_TREASURY],
  );
  assert.ok(sent.rows[0].n >= 1);
});

test('a vault sheet posts only non-zero books and a reprint does not post again', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await applicationPool.query(
    `UPDATE branches SET printer_target = '10.1.4.21' WHERE branch_id = $1`,
    [desk.branchId],
  );
  const before = await lineCount(applicationPool);
  const actor = {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    userId: desk.users.c1.user_id,
    role: 'VAULT_CUSTODIAN',
    email: 'charles.amulike@demo-bank.example',
  };
  const body = {
    direction: 'FROM_VAULT',
    operating_date: DATE,
    books: {
      KWACHA_TREASURY: { REISSUABLE: { K100: '100.00' } },
      FOREIGN_CURRENCY: {},
      BANCS_TREASURY: { USD: { '2': '20.00' } },
    },
    c1_id: desk.users.c1.user_id,
    c1_pin: desk.pin,
    c2_id: desk.users.c2.user_id,
    c2_pin: desk.pin,
    coord_id: desk.users.coord.user_id,
    coord_pin: desk.pin,
  };
  const failed = await createVaultSheet(applicationPool, actor, desk.branchId, body, {
    printer: async () => { throw new Error('tray empty'); },
  });
  assert.equal(failed.print.status, 'FAILED');
  assert.equal(failed.printed_at, null);
  assert.equal(await lineCount(applicationPool), before + 2);
  assert.ok(failed.line_ids.KWACHA_TREASURY);
  assert.equal(failed.line_ids.FOREIGN_CURRENCY, null);
  assert.ok(failed.line_ids.BANCS_TREASURY);
  const labels = await applicationPool.query(
    `SELECT accounting_label, flow_direction FROM vault_denomination_matrix_ledger
     WHERE line_reference = $1 ORDER BY matrix_tx_id`,
    [`VS-${failed.sheet_id}`],
  );
  assert.deepEqual(labels.rows.map((row) => row.accounting_label), ['Out', 'Out']);
  assert.deepEqual(labels.rows.map((row) => row.flow_direction), ['OUT', 'OUT']);

  const again = await reprintVaultSheet(applicationPool, actor, failed.sheet_id, {
    printer: async () => {},
  });
  assert.equal(again.print.status, 'SENT');
  assert.equal(await lineCount(applicationPool), before + 2);
  const printed = await applicationPool.query(
    'SELECT printed_at FROM vault_sheets WHERE sheet_id = $1',
    [failed.sheet_id],
  );
  assert.ok(printed.rows[0].printed_at);
});

test('takeover and surprise prints do not roll back, and a reprint adds no narration', async () => {
  const { applicationPool } = pools();
  const desk = await createDesk(pinHash);
  await applicationPool.query(
    `UPDATE branch_vault_books SET status = 'BALANCED_CLOSED', closed_at = now()
     WHERE branch_id = $1 AND business_date = $2`,
    [desk.branchId, DATE],
  );
  await applicationPool.query(
    `UPDATE branches SET printer_target = '10.1.4.22' WHERE branch_id = $1`,
    [desk.branchId],
  );
  const incoming = {};
  for (const [key, email, name, employeeId, initials, role] of [
    ['CUSTODIAN_ONE', 'relief.one@demo-bank.example', 'Relief Custodian', 'CUST-0301', 'R.C.', 'VAULT_CUSTODIAN'],
    ['CUSTODIAN_TWO', 'relief.two@demo-bank.example', 'Second Relief Custodian', 'CUST-0302', 'S.R.', 'VAULT_CUSTODIAN'],
    ['HEAD_TELLER', 'relief.coord@demo-bank.example', 'Relief Coordinator', 'TELL-0902', 'R.K.', 'HEAD_TELLER_COORDINATOR'],
  ]) {
    const inserted = await applicationPool.query(
      `INSERT INTO nodevault_users (
         tenant_id, branch_id, work_email, full_legal_name, employee_id,
         two_letter_initials, system_role, closing_pin_hash, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       RETURNING user_id, employee_id, two_letter_initials`,
      [desk.tenantId, desk.branchId, email, name, employeeId, initials, role, pinHash],
    );
    incoming[key] = inserted.rows[0];
  }
  const captured = await captureHandover(applicationPool, {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    effectiveDate: '2026-10-05',
    at: new Date('2026-10-05T06:00:00.000Z'),
    posts: Object.entries(incoming).map(([postCode, user]) => ({
      postCode,
      incomingUserId: user.user_id,
      employeeId: user.employee_id,
      initials: user.two_letter_initials,
      outgoingPin: '135790',
      incomingPin: '135790',
    })),
  });
  const narrations = await applicationPool.query('SELECT COUNT(*)::int AS n FROM book_narrations');
  const failed = await printTakeoverSlip(applicationPool, desk.tenantId, captured.handoverId, {
    printer: async () => { throw new Error('offline'); },
  });
  assert.equal(failed.status, 'FAILED');
  const still = await applicationPool.query('SELECT COUNT(*)::int AS n FROM book_narrations');
  assert.equal(still.rows[0].n, narrations.rows[0].n);
  const slip = await takeoverSlip(applicationPool, desk.tenantId, captured.handoverId);
  assert.equal(slip.head_teller, undefined);
  const linesBefore = await lineCount(applicationPool);
  const sent = await printTakeoverSlip(applicationPool, desk.tenantId, captured.handoverId);
  assert.equal(sent.status, 'SENT');
  assert.equal(await lineCount(applicationPool), linesBefore);
  assert.equal((await applicationPool.query('SELECT COUNT(*)::int AS n FROM book_narrations')).rows[0].n, narrations.rows[0].n);

  const auditor = await applicationPool.query(
    `INSERT INTO nodevault_users (
       tenant_id, branch_id, work_email, full_legal_name, employee_id,
       two_letter_initials, system_role, closing_pin_hash, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
     RETURNING user_id, work_email, full_legal_name, employee_id`,
    [desk.tenantId, desk.branchId, 'auditor.desk@demo-bank.example', 'Branch Auditor', 'AUD-0012', 'A.U.', 'AUDITOR', pinHash],
  );
  const checker = {
    tenantId: desk.tenantId,
    branchId: desk.branchId,
    userId: auditor.rows[0].user_id,
    role: 'AUDITOR',
    email: auditor.rows[0].work_email,
    fullLegalName: auditor.rows[0].full_legal_name,
    employeeId: auditor.rows[0].employee_id,
  };
  const check = await recordSurpriseCheck(applicationPool, checker, {
    checked_at: '2026-10-03T12:30:00.000Z',
    business_date: DATE,
    books: [
      { book_class: 'KWACHA_TREASURY', counted: { ZMW: '1656515.00' } },
      { book_class: 'FOREIGN_CURRENCY', counted: { EUR: '0.00', GBP: '0.00', USD: '8000.00', ZAR: '25000.00' } },
      { book_class: 'BANCS_TREASURY', counted: { EUR: '1500.00', GBP: '500.00', USD: '220.00', ZAR: '400.00' } },
    ],
  });
  const surpriseFailed = await printSurpriseSlip(applicationPool, desk.tenantId, check.check_id, {
    printer: async () => { throw new Error('offline'); },
  });
  assert.equal(surpriseFailed.status, 'FAILED');
  const checks = await applicationPool.query('SELECT COUNT(*)::int AS n FROM surprise_checks');
  assert.equal(checks.rows[0].n, 1);
  const surpriseSent = await printSurpriseSlip(applicationPool, desk.tenantId, check.check_id);
  assert.equal(surpriseSent.status, 'SENT');
  assert.equal((await applicationPool.query('SELECT COUNT(*)::int AS n FROM surprise_checks')).rows[0].n, 1);
  assert.equal(await lineCount(applicationPool), linesBefore);
});

test('the desk does not draw the logo or open a browser print dialog', () => {
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((match) => match[1]);
  assert.deepEqual(images, ['/logo.png', '/logo.png']);
  assert.equal(html.includes('fnb-logo-placeholder.png'), false);
  assert.equal(html.includes('fnb-logo'), false);
  assert.equal(app.includes('window.print'), false);
  assert.equal(app.includes('slip-logo'), false);
  assert.equal(app.includes('fnb-logo'), false);
});
