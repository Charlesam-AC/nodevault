const path = require('path');
const express = require('express');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createPool, waitForDb } = require('./db');
const { VaultError } = require('./services/errors');
const { syncCatalogue } = require('./services/catalogue');
const { seedDemo, ensureMasterAdmin } = require('./services/seed');
const { ensureWorkingBooks } = require('./services/workingBooks');
const { listBooks, listBookDates } = require('./services/books');
const { businessMorning, isBusinessDay, zonedParts } = require('./services/calendar');
const { carryForwardBranch, listCarryFlags } = require('./services/carry');
const {
  optionsForBranch,
  calendarDesk,
  declareClosure,
  cancelClosure,
  declareGazetted,
  cancelGazetted,
} = require('./services/closures');
const { holdersForDate, rotationView, captureHandover } = require('./services/rotation');
const { getBookView, insertLedgerRow, writeCarriedDown } = require('./services/ledger');
const { recordAudit } = require('./services/audit');
const { executeThreePersonVaultLock, dispatchClosing } = require('./services/closing');
const { openBreakGlass } = require('./services/breakglass');
const { readEntraEnabled, setEntraEnabled } = require('./services/entraToggle');
const { actAsUser, returnToAdmin } = require('./services/actAs');
const { toDecimalString } = require('./services/money');
const {
  authenticateCorporateIdentity,
  authenticateLocalPassword,
  localLoginEnabled,
  signSession,
  requireAuth,
  isMasterAdmin,
} = require('./middleware/auth');

function sessionBody(user) {
  return {
    user_id: user.user_id,
    full_legal_name: user.full_legal_name,
    work_email: user.work_email,
    system_role: user.system_role,
    bank_name: user.bank_name,
  };
}

function sendError(res, error) {
  if (error instanceof VaultError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'INTERNAL', message: 'The vault desk could not complete that request.' });
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function deskCanPost(user) {
  if (user.role === 'VAULT_CUSTODIAN' || user.role === 'HEAD_TELLER_COORDINATOR') return true;
  if (user.role === 'IT_SUPER_ADMIN' && user.breakGlassId) return true;
  return isMasterAdmin({ work_email: user.email }) && !user.actorUserId;
}

function entrySignatories(body) {
  const label = String(body.accounting_label || '').trim();
  if (!label || label.length > 32) {
    throw new VaultError('INVALID_LABEL', 'A reference of up to 32 characters is required');
  }
  const reference = String(body.line_reference ?? '').trim();
  if (reference.length > 32) {
    throw new VaultError('INVALID_LABEL', 'A reference of up to 32 characters is required');
  }
  return {
    custodianOneInitials: body.custodian_one_initials,
    custodianTwoInitials: body.custodian_two_initials,
    tellerCoordInitials: body.teller_coord_initials,
    accountingLabel: label,
    lineReference: reference || null,
  };
}

function movementHasAmount(amounts) {
  if (!amounts || typeof amounts !== 'object' || Array.isArray(amounts)) return false;
  for (const channel of Object.values(amounts)) {
    if (!channel || typeof channel !== 'object') continue;
    for (const value of Object.values(channel)) {
      if (value !== undefined && value !== null && String(value).trim() !== '' && String(value) !== '0' && String(value) !== '0.00') {
        return true;
      }
    }
  }
  return false;
}

function buildApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const guard = requireAuth(db);

  app.get('/health', asyncRoute(async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok', service: 'nodevault-api' });
    } catch (_error) {
      res.status(503).json({ status: 'db_unavailable' });
    }
  }));

  app.get('/api/public-config', asyncRoute(async (_req, res) => {
    res.json({
      product: 'NodeVault',
      entraMode: process.env.ENTRA_MODE || 'mock',
      enforcedDomain: process.env.ENFORCED_CORPORATE_DOMAIN || '',
      authMode: process.env.AUTH_MODE || 'both',
      localLogin: localLoginEnabled(),
      entraEnabled: await readEntraEnabled(db),
    });
  }));

  app.get('/api/auth/entra', guard, asyncRoute(async (req, res) => {
    res.json({
      entraEnabled: await readEntraEnabled(db, req.user.tenantId),
      canToggle: req.user.role === 'IT_SUPER_ADMIN',
    });
  }));

  app.put('/api/auth/entra', guard, asyncRoute(async (req, res) => {
    res.json(await setEntraEnabled(db, req.user, req.body.enabled));
  }));

  app.get('/api/auth/demo-directory', asyncRoute(async (_req, res) => {
    if ((process.env.ENTRA_MODE || 'mock') !== 'mock' || process.env.SEED_DEMO_DATA !== 'true') {
      throw new VaultError('NOT_FOUND', 'No demo directory is published', 404);
    }
    const rows = await db.query(
      `SELECT work_email, full_legal_name, system_role, two_letter_initials, employee_id
       FROM nodevault_users
       ORDER BY user_id`,
    );
    res.json({ users: rows.rows });
  }));

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const user = await authenticateCorporateIdentity(db, {
      email: req.body.email,
      assertion: req.body.assertion,
    });
    const token = signSession(user);
    res.json({ token, user: sessionBody(user) });
  }));

  app.post('/api/auth/login/password', asyncRoute(async (req, res) => {
    const user = await authenticateLocalPassword(db, {
      email: req.body.email,
      password: req.body.password,
    });
    const token = signSession(user);
    res.json({ token, user: sessionBody(user) });
  }));

  app.post('/api/auth/act-as', guard, asyncRoute(async (req, res) => {
    res.json(await actAsUser(db, req.user, req.body.user_id));
  }));

  app.post('/api/auth/act-as/return', guard, asyncRoute(async (req, res) => {
    res.json(await returnToAdmin(db, req.user));
  }));

  app.post('/api/auth/break-glass', asyncRoute(async (req, res) => {
    const opened = await openBreakGlass(db, req.body);
    res.json(opened);
  }));

  app.get('/api/me', guard, (req, res) => {
    res.json({
      user_id: req.user.userId,
      full_legal_name: req.user.fullLegalName,
      work_email: req.user.email,
      system_role: req.user.role,
      employee_id: req.user.employeeId,
      initials: req.user.initials,
      bank_name: req.user.bankName,
      break_glass: Boolean(req.user.breakGlassId),
      break_glass_expires_at: req.user.breakGlassExpires,
      can_act_as: isMasterAdmin({ work_email: req.user.email }) && !req.user.actorUserId,
      acting_as: Boolean(req.user.actorUserId),
      actor_name: req.user.actorName,
    });
  });

  app.get('/api/directory', guard, asyncRoute(async (req, res) => {
    const rows = await db.query(
      `SELECT user_id, full_legal_name, work_email, employee_id, two_letter_initials, system_role
       FROM nodevault_users
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY employee_id`,
      [req.user.tenantId],
    );
    res.json({ users: rows.rows });
  }));

  app.get('/api/books', guard, asyncRoute(async (req, res) => {
    res.json(await prepareDesk(db, req.user, new Date(), req.query.date || null));
  }));

  app.get('/api/rotation', guard, asyncRoute(async (req, res) => {
    const desk = await prepareDesk(db, req.user);
    res.json(desk);
  }));

  app.post('/api/calendar/closures', guard, asyncRoute(async (req, res) => {
    const created = await declareClosure(db, req.user, req.body);
    res.status(201).json(created);
  }));

  app.post('/api/calendar/closures/:closureId/cancel', guard, asyncRoute(async (req, res) => {
    const cancelled = await cancelClosure(db, req.user, req.params.closureId);
    res.json(cancelled);
  }));

  app.post('/api/calendar/gazetted', guard, asyncRoute(async (req, res) => {
    const created = await declareGazetted(db, req.user, req.body);
    res.status(201).json(created);
  }));

  app.post('/api/calendar/gazetted/:holidayId/cancel', guard, asyncRoute(async (req, res) => {
    const cancelled = await cancelGazetted(db, req.user, req.params.holidayId);
    res.json(cancelled);
  }));

  app.post('/api/rotation/handover', guard, asyncRoute(async (req, res) => {
    const branchId = req.user.branchId;
    if (!branchId) throw new VaultError('NO_BRANCH', 'This profile is not attached to a branch', 409);
    const captured = await captureHandover(db, {
      tenantId: req.user.tenantId,
      branchId,
      effectiveDate: req.body.effective_date,
      posts: req.body.posts,
    });
    res.status(201).json(captured);
  }));

  app.get('/api/books/:bookId', guard, asyncRoute(async (req, res) => {
    const view = await getBookView(db, req.user.tenantId, req.params.bookId);
    res.json(view);
  }));

  app.post('/api/books/:bookId/entries', guard, asyncRoute(async (req, res) => {
    if (!deskCanPost(req.user)) {
      throw new VaultError('WRONG_ROLE', 'This desk cannot add ledger rows', 403);
    }
    if (!movementHasAmount(req.body.amounts)) {
      throw new VaultError('INVALID_AMOUNT', 'Enter an amount on at least one denomination');
    }
    const book = await db.query(
      `SELECT business_date::text AS business_date
       FROM branch_vault_books
       WHERE book_id = $1 AND tenant_id = $2`,
      [req.params.bookId, req.user.tenantId],
    );
    if (book.rowCount !== 1) throw new VaultError('BOOK_NOT_FOUND', 'Treasury book not found', 404);
    const signatories = entrySignatories(req.body);
    const created = await insertLedgerRow(db, {
      tenantId: req.user.tenantId,
      bookId: req.params.bookId,
      transactionDate: book.rows[0].business_date,
      ...signatories,
      flowDirection: req.body.flow_direction,
      amounts: req.body.amounts,
    });
    await recordAudit(db, {
      tenantId: req.user.tenantId,
      bookId: req.params.bookId,
      eventType: 'LEDGER_LINE_POSTED',
      actorUserIds: [req.user.userId],
      detail: {
        actor_user_id: req.user.actorUserId || null,
        line_number: created.lineNumber,
        flow_direction: req.body.flow_direction,
        accounting_label: signatories.accountingLabel,
        line_reference: signatories.lineReference,
      },
    });
    res.status(201).json(created);
  }));

  app.post('/api/books/:bookId/square', guard, asyncRoute(async (req, res) => {
    if (!deskCanPost(req.user)) {
      throw new VaultError('WRONG_ROLE', 'This desk cannot add ledger rows', 403);
    }
    const signatories = entrySignatories({
      ...req.body,
      accounting_label: 'Bal c/d',
    });
    const created = await writeCarriedDown(db, {
      tenantId: req.user.tenantId,
      bookId: req.params.bookId,
      ...signatories,
    });
    await recordAudit(db, {
      tenantId: req.user.tenantId,
      bookId: req.params.bookId,
      eventType: 'LEDGER_SQUARED',
      actorUserIds: [req.user.userId],
      detail: {
        actor_user_id: req.user.actorUserId || null,
        line_number: created.lineNumber,
      },
    });
    res.status(201).json(created);
  }));

  app.post('/api/books/:bookId/close', guard, asyncRoute(async (req, res) => {
    const book = await db.query(
      `SELECT branch_id FROM branch_vault_books WHERE book_id = $1 AND tenant_id = $2`,
      [req.params.bookId, req.user.tenantId],
    );
    if (book.rowCount !== 1) throw new VaultError('BOOK_NOT_FOUND', 'Treasury book not found', 404);
    const result = await executeThreePersonVaultLock(
      req.user.tenantId,
      book.rows[0].branch_id,
      { ...req.body, target_book_id: req.params.bookId },
      { pool: db },
    );
    res.json(result);
  }));

  app.post('/api/books/:bookId/dispatch/retry', guard, asyncRoute(async (req, res) => {
    const book = await db.query(
      `SELECT status FROM branch_vault_books WHERE book_id = $1 AND tenant_id = $2`,
      [req.params.bookId, req.user.tenantId],
    );
    if (book.rowCount !== 1) throw new VaultError('BOOK_NOT_FOUND', 'Treasury book not found', 404);
    if (book.rows[0].status !== 'BALANCED_CLOSED') {
      throw new VaultError('BOOK_OPEN', 'Only a closed book has a closing sheet to resend', 409);
    }
    const dispatch = await dispatchClosing(db, {
      tenantId: req.user.tenantId,
      bookId: req.params.bookId,
    });
    res.json({ status: 'SUCCESS', dispatch });
  }));

  if (process.env.ENABLE_CORE_BANK_STUB === 'true') {
    app.get('/mock/corebank/v1/position/:branchId', asyncRoute(async (req, res) => {
      const rows = await db.query(
        `SELECT currency_code, amount_minor
         FROM mock_core_positions
         WHERE branch_id = $1 AND book_id = $2 AND tenant_id = $3`,
        [req.params.branchId, req.query.book_id, req.query.tenant_id],
      );
      const outstanding = {};
      for (const row of rows.rows) {
        outstanding[row.currency_code.trim()] = toDecimalString(BigInt(row.amount_minor));
      }
      res.json({ outstanding });
    }));
  }

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.use((error, _req, res, _next) => {
    sendError(res, error);
  });
  return app;
}

async function latestBookDate(db, tenantId, branchId) {
  const result = await db.query(
    `SELECT business_date::text AS business_date
     FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2
     ORDER BY business_date DESC
     LIMIT 1`,
    [tenantId, branchId],
  );
  return result.rows[0] ? result.rows[0].business_date : null;
}

async function prepareDesk(db, user, now = new Date(), requestedDate = null) {
  const tenantId = user.tenantId;
  const branchId = user.branchId;
  if (!branchId) throw new VaultError('NO_BRANCH', 'This profile is not attached to a branch', 409);
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    throw new VaultError('WRONG_DATE', 'Book date must be YYYY-MM-DD');
  }
  const options = await optionsForBranch(db, tenantId, branchId, { now });
  const morning = businessMorning(now, options);
  const gate = morning
    ? await holdersForDate(db, tenantId, branchId, morning)
    : { open: true, missing: [] };
  if (morning && gate.open && !requestedDate) {
    await carryForwardBranch(db, tenantId, branchId, now, options);
  }
  const businessDate = requestedDate || morning || await latestBookDate(db, tenantId, branchId);
  const deskOpen = !morning || gate.open;
  const books = !businessDate || !deskOpen
    ? []
    : await listBooks(db, tenantId, businessDate);
  const rotation = await rotationView(db, tenantId, branchId, now, options);
  const carryFlags = businessDate
    ? await listCarryFlags(db, tenantId, branchId, businessDate)
    : [];
  const today = zonedParts(now, options.timeZone).isoDate;
  const calendar = await calendarDesk(db, tenantId, branchId, user, now);
  if (!isBusinessDay(today, options) && !calendar.nonWorking) {
    calendar.nonWorking = { date: today, name: 'Not a trading day' };
  }
  const dates = await listBookDates(db, tenantId, branchId);
  return {
    businessDate,
    deskOpen,
    missingPosts: gate.missing,
    books,
    dates,
    rotation,
    carryFlags,
    calendar,
  };
}

async function runMorning(db) {
  const branches = await db.query('SELECT tenant_id, branch_id FROM branches');
  for (const branch of branches.rows) {
    try {
      await prepareDesk(db, { tenantId: Number(branch.tenant_id), branchId: Number(branch.branch_id) });
    } catch (error) {
      console.error(JSON.stringify({ event: 'morning_job_failed', message: error.message }));
    }
  }
}

async function start() {
  if ((process.env.JWT_SECRET || '').length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  const db = createPool();
  await waitForDb(db);
  await syncCatalogue(db);
  if (process.env.SEED_DEMO_DATA === 'true') {
    await seedDemo(db);
    await ensureMasterAdmin(db);
    const working = await ensureWorkingBooks(db);
    console.log(JSON.stringify({ event: 'working_books', ...working }));
  }
  const app = buildApp(db);
  const port = Number(process.env.PORT || 8080);
  const server = app.listen(port, '0.0.0.0');
  console.log(JSON.stringify({ event: 'listening', port }));
  const morning = setInterval(() => {
    runMorning(db).catch((error) => {
      console.error(JSON.stringify({ event: 'morning_job_failed', message: error.message }));
    });
  }, 60 * 1000);
  if (typeof morning.unref === 'function') morning.unref();
  runMorning(db).catch((error) => {
    console.error(JSON.stringify({ event: 'morning_job_failed', message: error.message }));
  });
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { buildApp, start, prepareDesk };
