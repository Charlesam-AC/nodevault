const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { openBreakGlass, WINDOW_MS } = require('../services/breakglass');
const { authenticateCorporateIdentity, resolvePrincipal } = require('../middleware/auth');
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
  const desk = await createDesk(pinHash);
  const { applicationPool } = pools();
  const assertion = process.env.MOCK_ENTRA_ASSERTION;
  await assert.rejects(
    () => authenticateCorporateIdentity(applicationPool, {
      email: 'it.admin@demo-bank.example',
      assertion,
    }),
    (error) => error.code === 'ADMIN_FROZEN',
  );

  const now = new Date('2026-10-03T18:00:00.000Z');
  const opened = await openBreakGlass(applicationPool, {
    admin_email: 'it.admin@demo-bank.example',
    admin_assertion: assertion,
    custodian_one_email: 'charles.amulike@demo-bank.example',
    custodian_one_assertion: assertion,
    custodian_two_email: 'custodian.two@demo-bank.example',
    custodian_two_assertion: assertion,
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
      admin_assertion: assertion,
      custodian_one_email: 'charles.amulike@demo-bank.example',
      custodian_one_assertion: assertion,
      custodian_two_email: 'charles.amulike@demo-bank.example',
      custodian_two_assertion: assertion,
    }),
    (error) => error.code === 'DUPLICATE_SIGNATORY',
  );

  const audit = await applicationPool.query(
    `SELECT event_type FROM audit_events WHERE event_type = 'BREAK_GLASS_OPENED'`,
  );
  assert.equal(audit.rowCount, 1);
});
