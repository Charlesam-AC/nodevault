const { VaultError } = require('./errors');
const { authenticateCorporateIdentity, signSession } = require('../middleware/auth');
const { recordAudit } = require('./audit');

const WINDOW_MS = 60 * 60 * 1000;

async function openBreakGlass(db, body, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const admin = await authenticateCorporateIdentity(db, {
    email: body.admin_email,
    assertion: body.admin_assertion,
    allowFrozenAdmin: true,
    forBreakGlass: true,
  });
  if (admin.system_role !== 'IT_SUPER_ADMIN') {
    throw new VaultError('WRONG_ROLE', 'Break-glass is for the IT super admin', 403);
  }
  const control = await db.query(
    'SELECT it_admin_frozen FROM system_control WHERE tenant_id = $1',
    [admin.tenant_id],
  );
  if (!control.rows[0] || !control.rows[0].it_admin_frozen) {
    throw new VaultError('NOT_FROZEN', 'The IT super admin is not frozen. Sign in normally.', 409);
  }

  const emails = [body.custodian_one_email, body.custodian_two_email].map((email) => String(email || '').toLowerCase());
  if (emails[0] === emails[1] || emails.includes(admin.work_email)) {
    throw new VaultError('DUPLICATE_SIGNATORY', 'Both vault custodians must be distinct people', 400);
  }
  const c1 = await authenticateCorporateIdentity(db, {
    email: emails[0],
    assertion: body.custodian_one_assertion,
    forBreakGlass: true,
  });
  const c2 = await authenticateCorporateIdentity(db, {
    email: emails[1],
    assertion: body.custodian_two_assertion,
    forBreakGlass: true,
  });
  for (const custodian of [c1, c2]) {
    if (custodian.system_role !== 'VAULT_CUSTODIAN' || !custodian.is_active) {
      throw new VaultError('WRONG_ROLE', 'Break-glass requires two active vault custodians', 403);
    }
    if (Number(custodian.tenant_id) !== Number(admin.tenant_id)) {
      throw new VaultError('TENANT_MISMATCH', 'Custodians must belong to the same bank', 403);
    }
  }

  const expires = new Date(now.getTime() + WINDOW_MS);
  const session = await db.query(
    `INSERT INTO break_glass_sessions (
       tenant_id, admin_user_id, custodian_one_id, custodian_two_id, opened_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING session_id, opened_at, expires_at`,
    [admin.tenant_id, admin.user_id, c1.user_id, c2.user_id, now, expires],
  );
  await recordAudit(db, {
    tenantId: admin.tenant_id,
    eventType: 'BREAK_GLASS_OPENED',
    actorUserIds: [admin.user_id, c1.user_id, c2.user_id],
    detail: {
      session_id: Number(session.rows[0].session_id),
      expires_at: session.rows[0].expires_at,
    },
  });
  const token = signSession(admin, {
    breakGlassId: Number(session.rows[0].session_id),
    expiresInSeconds: 60 * 60,
  });
  return {
    token,
    expires_at: session.rows[0].expires_at,
    opened_at: session.rows[0].opened_at,
  };
}

module.exports = { openBreakGlass, WINDOW_MS };
