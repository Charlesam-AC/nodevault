const { VaultError } = require('./errors');
const { localLoginEnabled } = require('../middleware/auth');
const { recordAudit } = require('./audit');

function deploymentAllowsEntra() {
  return String(process.env.AUTH_MODE || 'both').toLowerCase() !== 'local';
}

async function readEntraEnabled(db, tenantId) {
  if (!deploymentAllowsEntra()) return false;
  const row = tenantId
    ? await db.query(
      'SELECT entra_enabled FROM system_control WHERE tenant_id = $1',
      [tenantId],
    )
    : await db.query(
      `SELECT c.entra_enabled
       FROM system_control c
       JOIN bank_tenants t ON t.tenant_id = c.tenant_id
       WHERE lower(t.corporate_domain) = lower($1)
          OR $1 = ''
       ORDER BY c.tenant_id
       LIMIT 1`,
      [process.env.ENFORCED_CORPORATE_DOMAIN || ''],
    );
  if (!row.rows[0]) return true;
  return row.rows[0].entra_enabled !== false;
}

async function setEntraEnabled(db, user, enabled) {
  if (user.role !== 'IT_SUPER_ADMIN') {
    throw new VaultError('WRONG_ROLE', 'Only the IT super admin can change Microsoft Entra sign-in.', 403);
  }
  const next = Boolean(enabled);
  if (next && !deploymentAllowsEntra()) {
    throw new VaultError(
      'ENTRA_LOCKED',
      'This deployment is set to local sign-in only. Microsoft Entra stays off.',
      409,
    );
  }
  if (!next && !localLoginEnabled()) {
    throw new VaultError(
      'LAST_DOOR',
      'Password sign-in is off. Leave Microsoft Entra on so the desk still has a way in.',
      409,
    );
  }
  const updated = await db.query(
    `UPDATE system_control
     SET entra_enabled = $2
     WHERE tenant_id = $1
     RETURNING entra_enabled`,
    [user.tenantId, next],
  );
  if (!updated.rows[0]) {
    throw new VaultError('NOT_FOUND', 'This bank has no system control row.', 404);
  }
  await recordAudit(db, {
    tenantId: user.tenantId,
    eventType: next ? 'ENTRA_ENABLED' : 'ENTRA_DISABLED',
    actorUserIds: [user.userId],
    detail: { entra_enabled: next },
  });
  return { entraEnabled: updated.rows[0].entra_enabled !== false };
}

module.exports = {
  deploymentAllowsEntra,
  readEntraEnabled,
  setEntraEnabled,
};
