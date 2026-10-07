const { VaultError } = require('./errors');
const { isMasterAdmin, signSession } = require('../middleware/auth');
const { recordAudit } = require('./audit');

function assertMasterAdmin(actor) {
  if (!actor || actor.actorUserId || !isMasterAdmin({ work_email: actor.email })) {
    throw new VaultError(
      'WRONG_ROLE',
      'Only the master admin can open the desk as another person.',
      403,
    );
  }
}

async function loadStaff(db, tenantId, userId) {
  const result = await db.query(
    `SELECT u.user_id, u.tenant_id, u.work_email, u.full_legal_name, u.system_role,
            u.is_active, t.bank_name
     FROM nodevault_users u
     JOIN bank_tenants t ON t.tenant_id = u.tenant_id
     WHERE u.user_id = $1 AND u.tenant_id = $2`,
    [userId, tenantId],
  );
  return result.rows[0] || null;
}

async function actAsUser(db, actor, targetUserId) {
  assertMasterAdmin(actor);
  const targetId = Number(targetUserId);
  if (!Number.isInteger(targetId)) {
    throw new VaultError('NOT_FOUND', 'That staff member is not on this desk.', 404);
  }
  const target = await loadStaff(db, actor.tenantId, targetId);
  if (!target || !target.is_active) {
    throw new VaultError('NOT_FOUND', 'That staff member is not on this desk.', 404);
  }
  if (Number(target.user_id) === Number(actor.userId)) {
    throw new VaultError('SAME_USER', 'You are already signed in as this person.', 409);
  }
  if (target.system_role === 'IT_SUPER_ADMIN') {
    throw new VaultError(
      'WRONG_ROLE',
      'The IT super admin desk stays on its own sign-in.',
      403,
    );
  }
  await recordAudit(db, {
    tenantId: actor.tenantId,
    eventType: 'ACT_AS',
    actorUserIds: [actor.userId],
    detail: {
      target_user_id: Number(target.user_id),
      target_email: target.work_email,
      target_role: target.system_role,
    },
  });
  return {
    token: signSession(target, { actorUserId: actor.userId }),
    user: {
      user_id: target.user_id,
      full_legal_name: target.full_legal_name,
      work_email: target.work_email,
      system_role: target.system_role,
      bank_name: target.bank_name,
    },
  };
}

async function returnToAdmin(db, principal) {
  if (!principal.actorUserId) {
    throw new VaultError('WRONG_ROLE', 'This session is already the admin desk.', 403);
  }
  const actor = await loadStaff(db, principal.tenantId, principal.actorUserId);
  if (!actor || !actor.is_active || !isMasterAdmin(actor)) {
    throw new VaultError('ACCESS_DENIED', 'Access denied', 401);
  }
  await recordAudit(db, {
    tenantId: principal.tenantId,
    eventType: 'ACT_AS_RETURN',
    actorUserIds: [actor.user_id],
    detail: {
      from_user_id: principal.userId,
      from_email: principal.email,
      from_role: principal.role,
    },
  });
  return {
    token: signSession(actor),
    user: {
      user_id: actor.user_id,
      full_legal_name: actor.full_legal_name,
      work_email: actor.work_email,
      system_role: actor.system_role,
      bank_name: actor.bank_name,
    },
  };
}

module.exports = { actAsUser, returnToAdmin };
