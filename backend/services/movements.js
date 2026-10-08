const { VaultError } = require('./errors');
const { isMasterAdmin } = require('../middleware/auth');

const DEFAULTS = [
  { label: 'Out ATM', flowDirection: 'OUT', carriesDown: false },
  { label: 'In ATM', flowDirection: 'IN', carriesDown: false },
  { label: 'In CIT', flowDirection: 'IN', carriesDown: false },
  { label: 'Out CIT', flowDirection: 'OUT', carriesDown: false },
  { label: 'Out Vault', flowDirection: 'OUT', carriesDown: false },
  { label: 'In Vault', flowDirection: 'IN', carriesDown: true },
];

function assertOptionManager(actor) {
  if (!actor || !isMasterAdmin({ work_email: actor.email }) || actor.actorUserId) {
    throw new VaultError('WRONG_ROLE', 'Only the master admin can change In or Out options', 403);
  }
}

function cleanLabel(value) {
  const label = String(value || '').trim().replace(/\s+/g, ' ');
  if (label.length < 2 || label.length > 32) {
    throw new VaultError('INVALID_OPTION', 'An In or Out option is 2 to 32 characters');
  }
  if (label === 'Bal b/f' || label === 'Bal b/d' || label === 'Bal c/d') {
    throw new VaultError('INVALID_OPTION', 'Bal b/f, Bal b/d, and Bal c/d stay balance lines');
  }
  return label;
}

function cleanFlow(value) {
  const flow = String(value || '').toUpperCase();
  if (flow !== 'IN' && flow !== 'OUT') {
    throw new VaultError('INVALID_FLOW', 'An option is In or Out');
  }
  return flow;
}

function present(row) {
  return {
    option_id: Number(row.option_id),
    label: row.label,
    flow_direction: row.flow_direction,
    carries_down: row.carries_down,
    sort_order: row.sort_order,
    is_active: row.is_active,
  };
}

async function restoreBuiltinNames(db, tenantId) {
  const result = await db.query(
    `SELECT option_id, label, flow_direction, carries_down, sort_order, is_active
     FROM movement_options
     WHERE tenant_id = $1
     ORDER BY sort_order, option_id`,
    [tenantId],
  );
  const rows = result.rows;
  for (let index = 0; index < DEFAULTS.length; index += 1) {
    const item = DEFAULTS[index];
    const exact = rows.find((row) => row.label === item.label);
    if (exact && exact.flow_direction === item.flowDirection && exact.carries_down === item.carriesDown) {
      if (!exact.is_active) {
        await db.query(
          `UPDATE movement_options SET is_active = true WHERE option_id = $1 AND tenant_id = $2`,
          [exact.option_id, tenantId],
        );
        exact.is_active = true;
      }
      continue;
    }
    if (exact) continue;
    const candidate = rows.find((row) => (
      item.carriesDown
        ? row.carries_down && row.flow_direction === 'IN'
        : !row.carries_down
          && row.sort_order === index + 1
          && row.flow_direction === item.flowDirection
          && !DEFAULTS.some((builtin) => builtin.label === row.label)
    ));
    if (!candidate) continue;
    await db.query(
      `UPDATE movement_options
       SET label = $1, is_active = true
       WHERE option_id = $2 AND tenant_id = $3`,
      [item.label, candidate.option_id, tenantId],
    );
    candidate.label = item.label;
    candidate.is_active = true;
  }
}

async function ensureMovementOptions(db, tenantId) {
  const existing = await db.query(
    `SELECT option_id FROM movement_options WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  if (existing.rowCount === 0) {
    for (let index = 0; index < DEFAULTS.length; index += 1) {
      const item = DEFAULTS[index];
      await db.query(
        `INSERT INTO movement_options
           (tenant_id, label, flow_direction, carries_down, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, item.label, item.flowDirection, item.carriesDown, index + 1],
      );
    }
  }
  await restoreBuiltinNames(db, tenantId);
}

async function listMovementOptions(db, tenantId) {
  await ensureMovementOptions(db, tenantId);
  const result = await db.query(
    `SELECT option_id, label, flow_direction, carries_down, sort_order, is_active
     FROM movement_options
     WHERE tenant_id = $1
     ORDER BY sort_order, option_id`,
    [tenantId],
  );
  return result.rows.map(present);
}

async function carryLabel(db, tenantId) {
  const options = await listMovementOptions(db, tenantId);
  const gate = options.find((option) => option.carries_down && option.is_active);
  return gate ? gate.label : 'In Vault';
}

async function assertMovementOption(db, tenantId, label, flowDirection) {
  const options = await listMovementOptions(db, tenantId);
  const match = options.find((option) => option.label === label && option.is_active);
  if (!match) {
    throw new VaultError('UNKNOWN_OPTION', 'Choose an In or Out option from the list', 400);
  }
  if (match.flow_direction !== flowDirection) {
    throw new VaultError('INVALID_FLOW', `${match.label} is ${match.flow_direction === 'IN' ? 'an In' : 'an Out'} line`, 400);
  }
  return match;
}

async function addMovementOption(db, actor, body) {
  assertOptionManager(actor);
  const label = cleanLabel(body.label);
  const flow = cleanFlow(body.flow_direction || body.flowDirection);
  await ensureMovementOptions(db, actor.tenantId);
  const next = await db.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS sort_order
     FROM movement_options WHERE tenant_id = $1`,
    [actor.tenantId],
  );
  try {
    const inserted = await db.query(
      `INSERT INTO movement_options (tenant_id, label, flow_direction, carries_down, sort_order)
       VALUES ($1, $2, $3, false, $4)
       RETURNING option_id, label, flow_direction, carries_down, sort_order, is_active`,
      [actor.tenantId, label, flow, next.rows[0].sort_order],
    );
    return present(inserted.rows[0]);
  } catch (error) {
    if (String(error.message).includes('movement_options_tenant_id_label_key')) {
      throw new VaultError('INVALID_OPTION', 'That In or Out option is already on the list', 409);
    }
    throw error;
  }
}

module.exports = {
  DEFAULTS,
  ensureMovementOptions,
  listMovementOptions,
  carryLabel,
  assertMovementOption,
  addMovementOption,
};
