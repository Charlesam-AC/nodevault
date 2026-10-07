const { VaultError } = require('./errors');
const { recordAudit } = require('./audit');
const { isMasterAdmin } = require('../middleware/auth');

const BUILTIN_ROLES = [
  { code: 'VAULT_CUSTODIAN', label: 'Vault custodian', pin: true },
  { code: 'ATM_CUSTODIAN', label: 'ATM custodian', pin: true },
  { code: 'TELLER', label: 'Teller', pin: false },
  { code: 'HEAD_TELLER_COORDINATOR', label: 'Head Teller', pin: true },
  { code: 'AUDITOR', label: 'Branch auditor', pin: false },
  { code: 'REGIONAL_OPS_MANAGER', label: 'Regional operations manager', pin: false },
  { code: 'BRANCH_ADMINISTRATOR', label: 'Branch Administrator', pin: false },
  { code: 'BRANCH_MANAGER', label: 'Branch Manager', pin: false },
];

const LOCKED_ROLES = {
  IT_SUPER_ADMIN: { code: 'IT_SUPER_ADMIN', label: 'IT super admin', pin: false },
};

const TIERS = [
  { code: 'READER', label: 'Reader of one branch' },
  { code: 'BRANCH_ADMINISTRATOR', label: 'Branch Administrator' },
  { code: 'BRANCH_MANAGER', label: 'Branch Manager' },
];

const BRANCH_SCOPED = new Set(['READER', 'BRANCH_ADMINISTRATOR', 'BRANCH_MANAGER']);
const DAY_TIERS = new Set(['BRANCH_ADMINISTRATOR', 'BRANCH_MANAGER']);
const MANAGER_ASSIGNABLE = new Set(['TELLER', 'READER', 'BRANCH_ADMINISTRATOR', 'BRANCH_MANAGER']);

function builtinRole(code) {
  return BUILTIN_ROLES.find((role) => role.code === code) || LOCKED_ROLES[code] || null;
}

function tierLabel(code) {
  const tier = TIERS.find((item) => item.code === code);
  return tier ? tier.label : code;
}

function powers(spec) {
  const tier = spec ? spec.tier : '';
  return {
    branchScoped: BRANCH_SCOPED.has(tier),
    canSetDay: DAY_TIERS.has(tier),
    canManageOwnBranch: tier === 'BRANCH_MANAGER',
    canAssignBranchStaff: tier === 'BRANCH_MANAGER',
  };
}

function managerMayAssign(spec) {
  return Boolean(spec && MANAGER_ASSIGNABLE.has(spec.tier) && spec.code !== 'IT_SUPER_ADMIN');
}

function assertCatalogueManager(actor) {
  if (!actor || !isMasterAdmin({ work_email: actor.email }) || actor.actorUserId) {
    throw new VaultError('WRONG_ROLE', 'Only the master admin can change roles', 403);
  }
}

function cleanRoleName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) {
    throw new VaultError('INVALID_ROLE', 'A role name is 2 to 80 characters');
  }
  return name;
}

function assertTier(value) {
  const tier = TIERS.find((item) => item.code === value);
  if (!tier) throw new VaultError('INVALID_ROLE', 'Choose a power for this role');
  return tier;
}

function assertRoleCode(value) {
  const code = String(value || '');
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) {
    throw new VaultError('INVALID_ROLE', 'Choose a desk role');
  }
  return code;
}

async function describeRole(db, tenantId, code) {
  const built = builtinRole(code);
  if (built) {
    return {
      code: built.code,
      label: built.label,
      pin: built.pin,
      tier: built.code,
      builtin: true,
      branchScoped: BRANCH_SCOPED.has(built.code),
    };
  }
  if (!code || !tenantId) return null;
  const result = await db.query(
    `SELECT role_code, display_name, power_tier
     FROM desk_roles
     WHERE tenant_id = $1 AND role_code = $2`,
    [tenantId, code],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    code: row.role_code,
    label: row.display_name,
    pin: false,
    tier: row.power_tier,
    builtin: false,
    branchScoped: true,
  };
}

async function roleLabels(db, tenantId) {
  const map = new Map(BUILTIN_ROLES.map((role) => [role.code, role.label]));
  map.set('IT_SUPER_ADMIN', 'IT super admin');
  if (!tenantId) return map;
  const custom = await db.query(
    `SELECT role_code, display_name FROM desk_roles WHERE tenant_id = $1`,
    [tenantId],
  );
  for (const row of custom.rows) map.set(row.role_code, row.display_name);
  return map;
}

async function catalogue(db, tenantId) {
  const [counted, custom] = await Promise.all([
    db.query(
      `SELECT system_role, COUNT(*)::int AS n
       FROM nodevault_users
       WHERE tenant_id = $1
       GROUP BY system_role`,
      [tenantId],
    ),
    db.query(
      `SELECT role_code, display_name, power_tier
       FROM desk_roles
       WHERE tenant_id = $1
       ORDER BY display_name, role_code`,
      [tenantId],
    ),
  ]);
  const holders = new Map(counted.rows.map((row) => [row.system_role, row.n]));
  return [
    ...BUILTIN_ROLES.map((role) => ({
      code: role.code,
      label: role.label,
      pin: role.pin,
      builtin: true,
      tier: role.code,
      tier_label: 'Built in',
      holders: holders.get(role.code) || 0,
    })),
    ...custom.rows.map((row) => ({
      code: row.role_code,
      label: row.display_name,
      pin: false,
      builtin: false,
      tier: row.power_tier,
      tier_label: tierLabel(row.power_tier),
      holders: holders.get(row.role_code) || 0,
    })),
  ];
}

async function listRoles(db, actor) {
  assertCatalogueManager(actor);
  return {
    can_manage: true,
    tiers: TIERS.map((tier) => ({ code: tier.code, label: tier.label })),
    roles: await catalogue(db, actor.tenantId),
  };
}

function rejectBuiltinName(name) {
  const folded = name.toLowerCase();
  const clash = BUILTIN_ROLES.some((role) => role.label.toLowerCase() === folded)
    || folded === 'it super admin';
  if (clash) {
    throw new VaultError('ROLE_NAME_TAKEN', 'That name belongs to a built-in role', 409);
  }
}

async function assertUniqueName(db, tenantId, name, exceptCode) {
  rejectBuiltinName(name);
  const result = await db.query(
    `SELECT role_code FROM desk_roles
     WHERE tenant_id = $1 AND lower(display_name) = lower($2)`,
    [tenantId, name],
  );
  if (result.rows.some((row) => row.role_code !== exceptCode)) {
    throw new VaultError('ROLE_NAME_TAKEN', 'A role with that name is already on the desk', 409);
  }
}

async function freshCode(db, tenantId, name) {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (slug.length < 2) throw new VaultError('INVALID_ROLE', 'Name the role with at least two letters');
  let code = `CUSTOM_${slug}`.slice(0, 40);
  for (let n = 2; n < 40; n += 1) {
    const taken = await db.query(
      `SELECT 1 FROM desk_roles WHERE tenant_id = $1 AND role_code = $2`,
      [tenantId, code],
    );
    if (!taken.rowCount && !builtinRole(code)) return code;
    code = `CUSTOM_${slug}_${n}`.slice(0, 40);
  }
  throw new VaultError('INVALID_ROLE', 'Choose a different role name');
}

async function addRole(db, actor, body) {
  assertCatalogueManager(actor);
  const name = cleanRoleName(body.display_name || body.name);
  const tier = assertTier(body.power_tier || body.tier);
  await assertUniqueName(db, actor.tenantId, name);
  const code = await freshCode(db, actor.tenantId, name);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO desk_roles (tenant_id, role_code, display_name, power_tier)
       VALUES ($1, $2, $3, $4)`,
      [actor.tenantId, code, name, tier.code],
    );
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'ROLE_ADDED',
      actorUserIds: [actor.userId],
      detail: { role_code: code, display_name: name, power_tier: tier.code },
    });
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
  return {
    code,
    label: name,
    pin: false,
    builtin: false,
    tier: tier.code,
    tier_label: tier.label,
    holders: 0,
  };
}

async function renameRole(db, actor, roleCode, body) {
  assertCatalogueManager(actor);
  const code = assertRoleCode(roleCode);
  if (builtinRole(code)) {
    throw new VaultError('ROLE_LOCKED', 'A built-in role keeps its name and its powers', 403);
  }
  const name = cleanRoleName(body.display_name || body.name);
  const existing = await describeRole(db, actor.tenantId, code);
  if (!existing || existing.builtin) {
    throw new VaultError('ROLE_MISSING', 'That role is not on this bank', 404);
  }
  await assertUniqueName(db, actor.tenantId, name, code);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE desk_roles SET display_name = $1
       WHERE tenant_id = $2 AND role_code = $3`,
      [name, actor.tenantId, code],
    );
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'ROLE_RENAMED',
      actorUserIds: [actor.userId],
      detail: { role_code: code, display_name: name },
    });
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
  return { ...(await describeRole(db, actor.tenantId, code)), builtin: false };
}

async function removeRole(db, actor, roleCode) {
  assertCatalogueManager(actor);
  const code = assertRoleCode(roleCode);
  if (builtinRole(code)) {
    throw new VaultError('ROLE_LOCKED', 'A built-in role stays on the desk', 403);
  }
  const existing = await describeRole(db, actor.tenantId, code);
  if (!existing) throw new VaultError('ROLE_MISSING', 'That role is not on this bank', 404);
  const held = await db.query(
    `SELECT COUNT(*)::int AS n FROM nodevault_users
     WHERE tenant_id = $1 AND system_role = $2`,
    [actor.tenantId, code],
  );
  const holders = held.rows[0].n;
  if (holders > 0) {
    throw new VaultError(
      'ROLE_IN_USE',
      holders === 1
        ? 'One person still holds this role'
        : `${holders} people still hold this role`,
      409,
    );
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM desk_roles WHERE tenant_id = $1 AND role_code = $2`,
      [actor.tenantId, code],
    );
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'ROLE_REMOVED',
      actorUserIds: [actor.userId],
      detail: { role_code: code, display_name: existing.label },
    });
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
  return { code, removed: true };
}

module.exports = {
  BUILTIN_ROLES,
  TIERS,
  powers,
  managerMayAssign,
  describeRole,
  roleLabels,
  catalogue,
  listRoles,
  addRole,
  renameRole,
  removeRole,
};
