const { VaultError } = require('./errors');
const { isMasterAdmin } = require('../middleware/auth');

const DEFAULTS = [
  { label: 'In', flowDirection: 'IN', carriesDown: false },
  { label: 'Out', flowDirection: 'OUT', carriesDown: false },
  { label: 'CIT In', flowDirection: 'IN', carriesDown: false },
  { label: 'CIT Out', flowDirection: 'OUT', carriesDown: false },
];

const RETIRED = ['Out ATM', 'In ATM', 'In CIT', 'Out CIT', 'Out Vault', 'In Vault'];

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

async function insertDefault(db, tenantId, item, sortOrder) {
  await db.query(
    `INSERT INTO movement_options
       (tenant_id, label, flow_direction, carries_down, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [tenantId, item.label, item.flowDirection, item.carriesDown, sortOrder],
  );
}

async function ensureMovementOptions(db, tenantId) {
  const existing = await db.query(
    `SELECT option_id, label, flow_direction, carries_down, sort_order, is_active
     FROM movement_options
     WHERE tenant_id = $1
     ORDER BY sort_order, option_id`,
    [tenantId],
  );
  if (existing.rowCount === 0) {
    for (let index = 0; index < DEFAULTS.length; index += 1) {
      await insertDefault(db, tenantId, DEFAULTS[index], index + 1);
    }
    return;
  }

  await db.query(
    `UPDATE movement_options
     SET is_active = false
     WHERE tenant_id = $1 AND label = ANY($2::text[])`,
    [tenantId, RETIRED],
  );

  const rows = existing.rows;
  for (let index = 0; index < DEFAULTS.length; index += 1) {
    const item = DEFAULTS[index];
    const exact = rows.find((row) => row.label === item.label);
    if (!exact) {
      await insertDefault(db, tenantId, item, index + 1);
      continue;
    }
    await db.query(
      `UPDATE movement_options
       SET flow_direction = $1, sort_order = $2, is_active = true
       WHERE option_id = $3 AND tenant_id = $4`,
      [item.flowDirection, index + 1, exact.option_id, tenantId],
    );
  }

  const customs = rows.filter((row) => (
    !DEFAULTS.some((item) => item.label === row.label)
    && !RETIRED.includes(row.label)
  ));
  for (let index = 0; index < customs.length; index += 1) {
    await db.query(
      `UPDATE movement_options SET sort_order = $1 WHERE option_id = $2 AND tenant_id = $3`,
      [DEFAULTS.length + 1 + index, customs[index].option_id, tenantId],
    );
  }
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
  return gate ? gate.label : null;
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
  const sortOrder = Math.max(Number(next.rows[0].sort_order), DEFAULTS.length + 1);
  try {
    const inserted = await db.query(
      `INSERT INTO movement_options (tenant_id, label, flow_direction, carries_down, sort_order)
       VALUES ($1, $2, $3, false, $4)
       RETURNING option_id, label, flow_direction, carries_down, sort_order, is_active`,
      [actor.tenantId, label, flow, sortOrder],
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
  RETIRED,
  ensureMovementOptions,
  listMovementOptions,
  carryLabel,
  assertMovementOption,
  addMovementOption,
};
