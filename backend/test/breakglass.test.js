const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { openBreakGlass, WINDOW_MS } = require('../services/breakglass');
const { authenticateCorporateIdentity, authenticateLocalPassword, resolvePrincipal } = require('../middleware/auth');
const { setupPools, resetDatabase, createDesk, closePools, pools } = require('./helpers');

let pinHash;

test.before(async () => {
  await setupPools();
  pinHash = await bcrypt.hash('135790', 6);
});

test.after(async () => {
  await closePools();
});

test('break-glass needs both custodians and expires after 60 minutes', async () => {
  await resetDatabase();
  await createDesk(pinHash);
  const { applicationPool, adminPool } = pools();
  const password = 'Vault-demo-2026';
  const passwordHash = await bcrypt.hash(password, 6);
  await adminPool.query(
    `UPDATE nodevault_users SET password_hash = $1
     WHERE work_email = ANY($2::text[])`,
    [passwordHash, [
      'it.admin@demo-bank.example',
      'charles.amulike@demo-bank.example',
      'custodian.two@demo-bank.example',
    ]],
  );
  process.env.ENABLE_LOCAL_LOGIN = 'true';
  process.env.AUTH_MODE = 'both';
  await assert.rejects(
    () => authenticateCorporateIdentity(applicationPool, {
      email: 'it.admin@demo-bank.example',
      assertion: 'change-me-entra-assertion',
    }),
    (error) => error.code === 'ENTRA_UNAVAILABLE',
  );
  await assert.rejects(
    () => authenticateLocalPassword(applicationPool, {
      email: 'it.admin@demo-bank.example',
      password,
    }),
    (error) => error.code === 'ADMIN_FROZEN',
  );

  const now = new Date('2026-10-03T18:00:00.000Z');
  const opened = await openBreakGlass(applicationPool, {
    admin_email: 'it.admin@demo-bank.example',
    admin_password: password,
    custodian_one_email: 'charles.amulike@demo-bank.example',
    custodian_one_password: password,
    custodian_two_email: 'custodian.two@demo-bank.example',
    custodian_two_password: password,
  }, { now: () => now });
  const span = new Date(opened.expires_at).getTime() - new Date(opened.opened_at).getTime();
  assert.equal(span, WINDOW_MS);

  const principal = await resolvePrincipal(applicationPool, opened.token, now);
  assert.equal(principal.breakGlassId > 0, true);

  await assert.rejects(
    () => resolvePrincipal(applicationPool, opened.token, new Date(now.getTime() + WINDOW_MS + 1000)),
    (error) => error.code === 'BREAK_GLASS_EXPIRED',
  );

  await assert.rejects(
    () => openBreakGlass(applicationPool, {
      admin_email: 'it.admin@demo-bank.example',
      admin_password: password,
      custodian_one_email: 'charles.amulike@demo-bank.example',
      custodian_one_password: password,
      custodian_two_email: 'charles.amulike@demo-bank.example',
      custodian_two_password: password,
    }),
    (error) => error.code === 'DUPLICATE_SIGNATORY',
  );
  await assert.rejects(
    () => openBreakGlass(applicationPool, {
      admin_email: 'it.admin@demo-bank.example',
      admin_assertion: 'change-me-entra-assertion',
      custodian_one_email: 'charles.amulike@demo-bank.example',
      custodian_one_assertion: 'change-me-entra-assertion',
      custodian_two_email: 'custodian.two@demo-bank.example',
      custodian_two_assertion: 'change-me-entra-assertion',
    }),
    (error) => error.code === 'ACCESS_DENIED',
  );

  const audit = await applicationPool.query(
    `SELECT event_type FROM audit_events WHERE event_type = 'BREAK_GLASS_OPENED'`,
  );
  assert.equal(audit.rowCount, 1);
});
