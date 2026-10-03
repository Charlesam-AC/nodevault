const path = require('path');
const express = require('express');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createPool, waitForDb } = require('./db');
const { VaultError } = require('./services/errors');
const { syncCatalogue } = require('./services/catalogue');
const { seedDemo } = require('./services/seed');
const { listBooks } = require('./services/books');
const { getBookView, insertLedgerRow } = require('./services/ledger');
const { executeThreePersonVaultLock, dispatchClosing } = require('./services/closing');
const { openBreakGlass } = require('./services/breakglass');
const { toDecimalString } = require('./services/money');
const {
  authenticateCorporateIdentity,
  signSession,
  requireAuth,
} = require('./middleware/auth');

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

  app.get('/api/public-config', (_req, res) => {
    res.json({
      product: 'NodeVault',
      entraMode: process.env.ENTRA_MODE || 'mock',
      enforcedDomain: process.env.ENFORCED_CORPORATE_DOMAIN || '',
    });
  });

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
    res.json({
      token,
      user: {
        user_id: user.user_id,
        full_legal_name: user.full_legal_name,
        work_email: user.work_email,
        system_role: user.system_role,
        bank_name: user.bank_name,
      },
    });
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
    const books = await listBooks(db, req.user.tenantId);
    res.json({ books });
  }));

  app.get('/api/books/:bookId', guard, asyncRoute(async (req, res) => {
    const view = await getBookView(db, req.user.tenantId, req.params.bookId);
    res.json(view);
  }));

  app.post('/api/books/:bookId/entries', guard, asyncRoute(async (req, res) => {
    const allowed = new Set(['VAULT_CUSTODIAN', 'HEAD_TELLER_COORDINATOR']);
    const maintenance = req.user.role === 'IT_SUPER_ADMIN' && req.user.breakGlassId;
    if (!allowed.has(req.user.role) && !maintenance) {
      throw new VaultError('WRONG_ROLE', 'This desk cannot add ledger rows', 403);
    }
    const created = await insertLedgerRow(db, {
      tenantId: req.user.tenantId,
      bookId: req.params.bookId,
      transactionDate: req.body.transaction_date,
      custodianOneInitials: req.body.custodian_one_initials,
      custodianTwoInitials: req.body.custodian_two_initials,
      tellerCoordInitials: req.body.teller_coord_initials,
      accountingLabel: req.body.accounting_label,
      flowDirection: req.body.flow_direction,
      amounts: req.body.amounts,
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

async function start() {
  if ((process.env.JWT_SECRET || '').length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  const db = createPool();
  await waitForDb(db);
  await syncCatalogue(db);
  if (process.env.SEED_DEMO_DATA === 'true') {
    await seedDemo(db);
  }
  const app = buildApp(db);
  const port = Number(process.env.PORT || 8080);
  const server = app.listen(port, '0.0.0.0');
  console.log(JSON.stringify({ event: 'listening', port }));
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { buildApp, start };
