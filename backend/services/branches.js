const { VaultError } = require('./errors');
const { recordAudit } = require('./audit');
const { isMasterAdmin } = require('../middleware/auth');
const { updateStaff } = require('./staff');

// Published First National Bank Zambia branches, from
// https://www.fnbzambia.co.zm/ways-to-bank/for-me/branch.html
// A spread across provinces, not the ATM list.
const KNOWN_BRANCHES = [
  { branch_code: '260039', branch_name: 'Acacia Premier Branch', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '260050', branch_name: 'Cairo Branch', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '260046', branch_name: 'Chilenje Branch', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '260322', branch_name: 'Chingola Branch', province: 'Copperbelt', location_name: 'Chingola' },
  { branch_code: '261121', branch_name: 'Chipata Branch', province: 'Eastern', location_name: 'Chipata' },
  { branch_code: '261238', branch_name: 'Choma Branch', province: 'Southern', location_name: 'Choma' },
  { branch_code: '260001', branch_name: 'Commercial Branch', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '260002', branch_name: 'Industrial Branch', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '260072', branch_name: 'Kabulonga Premier Branch', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '260937', branch_name: 'Kabwe Branch', province: 'Central', location_name: 'Kabwe' },
  { branch_code: '262874', branch_name: 'Kalumbila Branch', province: 'North-Western', location_name: 'Kalumbila' },
  { branch_code: '260247', branch_name: 'Kitwe Industrial Branch', province: 'Copperbelt', location_name: 'Kitwe' },
  { branch_code: '260212', branch_name: 'Kitwe Main Branch', province: 'Copperbelt', location_name: 'Kitwe' },
  { branch_code: '260261', branch_name: 'Kitwe Private Clients', province: 'Copperbelt', location_name: 'Kitwe' },
  { branch_code: '261061', branch_name: 'Livingstone Branch', province: 'Southern', location_name: 'Livingstone' },
  { branch_code: '260741', branch_name: 'Luanshya Branch', province: 'Copperbelt', location_name: 'Luanshya' },
  { branch_code: '260061', branch_name: 'Lusaka Private Clients', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '260016', branch_name: 'Makeni Branch', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '260014', branch_name: 'Manda Hill Branch', province: 'Lusaka', location_name: 'Lusaka' },
  { branch_code: '263613', branch_name: 'Mazabuka Branch', province: 'Southern', location_name: 'Mazabuka' },
  { branch_code: '262319', branch_name: 'Mkushi Branch', province: 'Central', location_name: 'Mkushi' },
  { branch_code: '260103', branch_name: 'Ndola Main Branch', province: 'Copperbelt', location_name: 'Ndola' },
  { branch_code: '262823', branch_name: 'Solwezi Branch', province: 'North-Western', location_name: 'Solwezi' },
];

function canManage(actor) {
  return isMasterAdmin({ work_email: actor.email }) && !actor.actorUserId;
}

function assertManager(actor) {
  if (!canManage(actor)) {
    throw new VaultError('WRONG_ROLE', 'Only the master admin can change branches', 403);
  }
}

function assertReader(actor) {
  if (actor.role === 'AUDITOR') return;
  assertManager(actor);
}

function cleanCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) {
    throw new VaultError('INVALID_BRANCH', 'A branch code is 2 to 20 letters, digits, or hyphens');
  }
  return code;
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) {
    throw new VaultError('INVALID_BRANCH', 'Enter the branch name');
  }
  return name;
}

function cleanPlace(value, label) {
  const place = String(value || '').trim().replace(/\s+/g, ' ');
  if (!place) return null;
  if (place.length < 2 || place.length > (label === 'Province' ? 80 : 120)) {
    throw new VaultError('INVALID_BRANCH', `${label} is too long`);
  }
  return place;
}

function rethrowBranch(error) {
  if (error instanceof VaultError) throw error;
  if (error.code === '23505') {
    throw new VaultError('BRANCH_CODE_TAKEN', 'That branch code is already on this bank', 409);
  }
  throw error;
}

async function loadBranch(db, tenantId, branchId) {
  const id = Number(branchId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new VaultError('NOT_FOUND', 'That branch is not on this bank', 404);
  }
  const result = await db.query(
    `SELECT branch_id, branch_code, branch_name, province, location_name, is_active, permanently_closed
     FROM branches
     WHERE tenant_id = $1 AND branch_id = $2`,
    [tenantId, id],
  );
  if (!result.rowCount) throw new VaultError('NOT_FOUND', 'That branch is not on this bank', 404);
  return result.rows[0];
}

function publicBranch(row, staff) {
  return {
    branch_id: Number(row.branch_id),
    branch_code: row.branch_code,
    branch_name: row.branch_name,
    province: row.province,
    location_name: row.location_name,
    is_active: row.is_active,
    permanently_closed: Boolean(row.permanently_closed),
    open_books: Number(row.open_books || 0),
    staff,
  };
}

async function listBranches(db, actor) {
  assertReader(actor);
  const [branches, people] = await Promise.all([
    db.query(
      `SELECT b.branch_id, b.branch_code, b.branch_name, b.province, b.location_name, b.is_active, b.permanently_closed,
              (
                SELECT COUNT(*)::int FROM branch_vault_books v
                WHERE v.tenant_id = b.tenant_id AND v.branch_id = b.branch_id AND v.status = 'OPEN'
              ) AS open_books
       FROM branches b
       WHERE b.tenant_id = $1
       ORDER BY b.is_active DESC, b.permanently_closed, b.branch_name`,
      [actor.tenantId],
    ),
    db.query(
      `SELECT user_id, full_legal_name, system_role, branch_id, is_active, work_email
       FROM nodevault_users
       WHERE tenant_id = $1
       ORDER BY is_active DESC, full_legal_name`,
      [actor.tenantId],
    ),
  ]);
  const byBranch = new Map();
  for (const person of people.rows) {
    if (!person.is_active || person.branch_id === null) continue;
    const list = byBranch.get(Number(person.branch_id)) || [];
    list.push({
      user_id: Number(person.user_id),
      full_legal_name: person.full_legal_name,
      system_role: person.system_role,
    });
    byBranch.set(Number(person.branch_id), list);
  }
  return {
    can_manage: canManage(actor),
    branches: branches.rows.map((row) => publicBranch(row, byBranch.get(Number(row.branch_id)) || [])),
    assignable: people.rows
      .filter((person) => person.is_active && person.system_role !== 'IT_SUPER_ADMIN' && !isMasterAdmin(person))
      .map((person) => ({
        user_id: Number(person.user_id),
        full_legal_name: person.full_legal_name,
        system_role: person.system_role,
        branch_id: person.branch_id === null ? null : Number(person.branch_id),
      })),
  };
}

async function addBranch(db, actor, body) {
  assertManager(actor);
  const code = cleanCode(body.branch_code);
  const name = cleanName(body.branch_name);
  const province = cleanPlace(body.province, 'Province');
  const location = cleanPlace(body.location_name, 'Town');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO branches (tenant_id, branch_code, branch_name, province, location_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING branch_id`,
      [actor.tenantId, code, name, province, location],
    );
    const branchId = Number(inserted.rows[0].branch_id);
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'BRANCH_ADDED',
      actorUserIds: [actor.userId],
      detail: { branch_id: branchId, branch_code: code, branch_name: name },
    });
    await client.query('COMMIT');
    return {
      branch_id: branchId,
      branch_code: code,
      branch_name: name,
      province,
      location_name: location,
      is_active: true,
      permanently_closed: false,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw rethrowBranch(error);
  } finally {
    client.release();
  }
}

async function updateBranch(db, actor, branchId, body) {
  assertManager(actor);
  const branch = await loadBranch(db, actor.tenantId, branchId);
  const next = {};
  if (Object.prototype.hasOwnProperty.call(body, 'branch_code')) next.branch_code = cleanCode(body.branch_code);
  if (Object.prototype.hasOwnProperty.call(body, 'branch_name')) next.branch_name = cleanName(body.branch_name);
  if (Object.prototype.hasOwnProperty.call(body, 'province')) next.province = cleanPlace(body.province, 'Province');
  if (Object.prototype.hasOwnProperty.call(body, 'location_name')) next.location_name = cleanPlace(body.location_name, 'Town');
  if (Object.prototype.hasOwnProperty.call(body, 'permanently_closed')) {
    if (body.permanently_closed !== true) {
      throw new VaultError('BRANCH_PERMANENT', 'A permanent close cannot be undone', 409);
    }
    if (body.is_active === true) {
      throw new VaultError('INVALID_BRANCH', 'A branch closed for good stays closed');
    }
    await assertCanClose(db, actor.tenantId, branch.branch_id);
    next.permanently_closed = true;
    next.is_active = false;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'is_active') && !next.permanently_closed) {
    if (typeof body.is_active !== 'boolean') {
      throw new VaultError('INVALID_BRANCH', 'Say whether this branch stays open');
    }
    if (body.is_active === true && branch.permanently_closed) {
      throw new VaultError('BRANCH_PERMANENT', 'This branch is closed for good and cannot be reopened', 409);
    }
    if (body.is_active === false) await assertCanClose(db, actor.tenantId, branch.branch_id);
    next.is_active = body.is_active;
  }
  if (!Object.keys(next).length) throw new VaultError('INVALID_BRANCH', 'Nothing on this branch was changed');
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(next)) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  values.push(branch.branch_id, actor.tenantId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE branches SET ${sets.join(', ')}
       WHERE branch_id = $${values.length - 1} AND tenant_id = $${values.length}`,
      values,
    );
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: next.permanently_closed
        ? 'BRANCH_PERMANENTLY_CLOSED'
        : (next.is_active === false ? 'BRANCH_CLOSED' : 'BRANCH_UPDATED'),
      actorUserIds: [actor.userId],
      detail: { branch_id: Number(branch.branch_id), fields: Object.keys(next) },
    });
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw rethrowBranch(error);
  } finally {
    client.release();
  }
  const saved = await loadBranch(db, actor.tenantId, branch.branch_id);
  return publicBranch(saved, []);
}

async function assertCanClose(db, tenantId, branchId) {
  const staff = await db.query(
    `SELECT COUNT(*)::int AS n FROM nodevault_users
     WHERE tenant_id = $1 AND branch_id = $2 AND is_active = true`,
    [tenantId, branchId],
  );
  if (Number(staff.rows[0].n) > 0) {
    throw new VaultError('BRANCH_IN_USE', 'Move the staff off this branch before closing it', 409);
  }
  const books = await db.query(
    `SELECT COUNT(*)::int AS n FROM branch_vault_books
     WHERE tenant_id = $1 AND branch_id = $2 AND status = 'OPEN'`,
    [tenantId, branchId],
  );
  if (Number(books.rows[0].n) > 0) {
    throw new VaultError('BRANCH_IN_USE', 'This branch still has an open treasury book', 409);
  }
}

async function closeBranch(db, actor, branchId) {
  return updateBranch(db, actor, branchId, { is_active: false });
}

async function assignBranch(db, actor, branchId, userId) {
  assertManager(actor);
  const branch = await loadBranch(db, actor.tenantId, branchId);
  if (branch.permanently_closed) {
    throw new VaultError('BRANCH_PERMANENT', 'This branch is closed for good', 409);
  }
  if (!branch.is_active) {
    throw new VaultError('BRANCH_CLOSED', 'Reopen this branch before assigning staff', 409);
  }
  return updateStaff(db, actor, userId, { branch_id: Number(branch.branch_id) });
}

async function ensureKnownBranches(db) {
  if (process.env.SEED_DEMO_DATA !== 'true') return { ensured: false, inserted: 0 };
  const tenant = await db.query('SELECT tenant_id FROM bank_tenants ORDER BY tenant_id LIMIT 1');
  if (!tenant.rowCount) return { ensured: false, inserted: 0 };
  const tenantId = tenant.rows[0].tenant_id;
  let inserted = 0;
  for (const branch of KNOWN_BRANCHES) {
    const result = await db.query(
      `INSERT INTO branches (tenant_id, branch_code, branch_name, province, location_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, branch_code) DO NOTHING`,
      [tenantId, branch.branch_code, branch.branch_name, branch.province, branch.location_name],
    );
    inserted += result.rowCount;
  }
  return { ensured: true, inserted };
}

module.exports = {
  KNOWN_BRANCHES,
  listBranches,
  addBranch,
  updateBranch,
  closeBranch,
  assignBranch,
  ensureKnownBranches,
};
