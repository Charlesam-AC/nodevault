const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { VaultError } = require('../services/errors');

function sameSecret(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function emailDomain(email) {
  const parts = String(email || '').toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : '';
}

function assertCorporateDomain(email, tenantDomain) {
  const domain = emailDomain(email);
  const enforced = (process.env.ENFORCED_CORPORATE_DOMAIN || '').toLowerCase();
  if (!domain || domain !== String(tenantDomain || '').toLowerCase()) {
    throw new VaultError('DOMAIN_REJECTED', 'Sign-in is restricted to the bank corporate domain', 403);
  }
  if (enforced && domain !== enforced) {
    throw new VaultError('DOMAIN_REJECTED', 'Sign-in is restricted to the bank corporate domain', 403);
  }
}

async function loadUserByEmail(db, email) {
  const result = await db.query(
    `SELECT u.user_id, u.tenant_id, u.work_email, u.full_legal_name, u.employee_id,
            u.two_letter_initials, u.system_role, u.is_active, t.corporate_domain, t.bank_name
     FROM nodevault_users u
     JOIN bank_tenants t ON t.tenant_id = u.tenant_id
     WHERE u.work_email = $1`,
    [String(email || '').toLowerCase()],
  );
  return result.rows[0] || null;
}

async function authenticateCorporateIdentity(db, { email, assertion, allowFrozenAdmin = false }) {
  const mode = process.env.ENTRA_MODE || 'mock';
  if (mode !== 'mock') {
    throw new VaultError(
      'ENTRA_UNAVAILABLE',
      'Live Microsoft Entra ID is not configured. Unsigned tokens are refused. Set ENTRA_MODE=mock for a local desk.',
      503,
    );
  }
  const expected = process.env.MOCK_ENTRA_ASSERTION || '';
  if (!expected || !sameSecret(assertion || '', expected)) {
    throw new VaultError('ACCESS_DENIED', 'Access denied', 401);
  }
  const user = await loadUserByEmail(db, email);
  if (!user || !user.is_active) {
    throw new VaultError('ACCESS_DENIED', 'Access denied', 401);
  }
  assertCorporateDomain(user.work_email, user.corporate_domain);
  if (user.system_role === 'IT_SUPER_ADMIN' && !allowFrozenAdmin) {
    const control = await db.query(
      'SELECT it_admin_frozen FROM system_control WHERE tenant_id = $1',
      [user.tenant_id],
    );
    if (control.rows[0] && control.rows[0].it_admin_frozen) {
      throw new VaultError(
        'ADMIN_FROZEN',
        'IT super admin access is frozen. Open a break-glass session with both vault custodians.',
        403,
      );
    }
  }
  return user;
}

function signSession(user, { breakGlassId = null, expiresInSeconds = null } = {}) {
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  const payload = {
    sub: user.user_id,
    tenant_id: user.tenant_id,
    role: user.system_role,
    email: user.work_email,
  };
  if (breakGlassId) payload.break_glass_id = breakGlassId;
  const expiresIn = expiresInSeconds || Number(process.env.SESSION_TTL_MINUTES || 480) * 60;
  return jwt.sign(payload, secret, { expiresIn });
}

async function resolvePrincipal(db, token, now = new Date()) {
  const secret = process.env.JWT_SECRET || '';
  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch (_error) {
    throw new VaultError('ACCESS_DENIED', 'Access denied', 401);
  }
  const result = await db.query(
    `SELECT u.user_id, u.tenant_id, u.work_email, u.full_legal_name, u.employee_id,
            u.two_letter_initials, u.system_role, u.is_active, t.corporate_domain, t.bank_name
     FROM nodevault_users u
     JOIN bank_tenants t ON t.tenant_id = u.tenant_id
     WHERE u.user_id = $1`,
    [payload.sub],
  );
  const user = result.rows[0];
  if (!user || !user.is_active || Number(user.tenant_id) !== Number(payload.tenant_id)) {
    throw new VaultError('ACCESS_DENIED', 'Access denied', 401);
  }
  assertCorporateDomain(user.work_email, user.corporate_domain);

  let breakGlassExpires = null;
  if (user.system_role === 'IT_SUPER_ADMIN') {
    const control = await db.query(
      'SELECT it_admin_frozen FROM system_control WHERE tenant_id = $1',
      [user.tenant_id],
    );
    const frozen = Boolean(control.rows[0] && control.rows[0].it_admin_frozen);
    if (frozen && !payload.break_glass_id) {
      throw new VaultError(
        'ADMIN_FROZEN',
        'IT super admin access is frozen. Open a break-glass session with both vault custodians.',
        403,
      );
    }
  }
  if (payload.break_glass_id) {
    const session = await db.query(
      `SELECT session_id, expires_at
       FROM break_glass_sessions
       WHERE session_id = $1 AND admin_user_id = $2 AND tenant_id = $3`,
      [payload.break_glass_id, user.user_id, user.tenant_id],
    );
    const row = session.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= now.getTime()) {
      throw new VaultError('BREAK_GLASS_EXPIRED', 'The break-glass session has expired', 401);
    }
    breakGlassExpires = row.expires_at;
  }
  return {
    userId: Number(user.user_id),
    tenantId: Number(user.tenant_id),
    role: user.system_role,
    email: user.work_email,
    fullLegalName: user.full_legal_name,
    employeeId: user.employee_id,
    initials: user.two_letter_initials,
    bankName: user.bank_name,
    breakGlassId: payload.break_glass_id ? Number(payload.break_glass_id) : null,
    breakGlassExpires,
  };
}

function requireAuth(db) {
  return async (req, res, next) => {
    try {
      const header = req.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!token) throw new VaultError('ACCESS_DENIED', 'Access denied', 401);
      req.user = await resolvePrincipal(db, token);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  sameSecret,
  emailDomain,
  authenticateCorporateIdentity,
  signSession,
  resolvePrincipal,
  requireAuth,
};
