const bcrypt = require('bcryptjs');
const { VaultError } = require('./errors');
const { recordAudit } = require('./audit');
const { addDays, diffDays, zonedParts, calendarOptions } = require('./calendar');
const { isMasterAdmin } = require('../middleware/auth');
const { POSTS } = require('./rotation');
const {
  BUILTIN_ROLES,
  catalogue,
  describeRole,
  managerMayAssign,
  powers,
} = require('./roles');

const ROLES = BUILTIN_ROLES;

function todayIso(now = new Date()) {
  return zonedParts(now, calendarOptions().timeZone).isoDate;
}

function canManage(actor) {
  return isMasterAdmin({ work_email: actor.email }) && !actor.actorUserId;
}

function assertManager(actor) {
  if (!canManage(actor)) {
    throw new VaultError('WRONG_ROLE', 'Only the master admin can change the staff register', 403);
  }
}

async function staffAccess(db, actor) {
  if (canManage(actor)) return { level: 'manage', scoped: false };
  if (actor.role === 'AUDITOR') return { level: 'read', scoped: false };
  const spec = await describeRole(db, actor.tenantId, actor.role);
  const power = powers(spec);
  if (power.branchScoped) {
    return { level: power.canAssignBranchStaff ? 'branch' : 'read', scoped: true };
  }
  throw new VaultError('WRONG_ROLE', 'Only the master admin can change the staff register', 403);
}

async function assertRole(db, tenantId, code) {
  const role = await describeRole(db, tenantId, code);
  if (!role || role.code === 'IT_SUPER_ADMIN') {
    throw new VaultError('INVALID_ROLE', 'Choose a desk role');
  }
  return role;
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) {
    throw new VaultError('INVALID_NAME', 'Enter the person’s full name');
  }
  return name;
}

function cleanEmployee(value) {
  const employeeId = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/.test(employeeId)) {
    throw new VaultError('INVALID_EMPLOYEE', 'Employee ID must be 2 to 32 letters, digits, or hyphens');
  }
  return employeeId;
}

function cleanInitials(value) {
  const initials = String(value || '').trim();
  if (!/^[A-Za-z](?:[A-Za-z.]{0,7})$/.test(initials) || initials.length > 8) {
    throw new VaultError('INVALID_INITIALS', 'Initials must be 1 to 8 letters, with dots allowed');
  }
  return initials;
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 160) {
    throw new VaultError('INVALID_EMAIL', 'Enter a work email on the bank domain');
  }
  return email;
}

function assertIso(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new VaultError('WRONG_DATE', `${label} must be YYYY-MM-DD`);
  }
  return String(value);
}

function assertPassword(password, pin) {
  const secret = String(password || '');
  if (secret.length < 10 || secret.length > 72) {
    throw new VaultError('INVALID_PASSWORD', 'The directory password must be 10 to 72 characters');
  }
  if (pin && secret === pin) {
    throw new VaultError('INVALID_PASSWORD', 'The directory password and the closing PIN must be different');
  }
  return secret;
}

function assertPin(pin, required) {
  const value = String(pin ?? '').trim();
  if (!value && !required) return null;
  if (!/^[0-9]{4,8}$/.test(value)) {
    throw new VaultError('INVALID_PIN', 'The closing PIN must be 4 to 8 digits');
  }
  return value;
}

function rethrowStaff(error) {
  if (error instanceof VaultError) throw error;
  const message = String(error.message || '');
  if (/corporate domain/i.test(message)) {
    throw new VaultError('DOMAIN_REJECTED', 'The work email must use the bank domain', 400);
  }
  if (error.code === '23505') {
    const constraint = String(error.constraint || '');
    if (constraint.includes('employee')) {
      throw new VaultError('EMPLOYEE_TAKEN', 'That employee ID is already on the register', 409);
    }
    if (constraint.includes('email')) {
      throw new VaultError('EMAIL_TAKEN', 'That work email is already on the register', 409);
    }
    throw new VaultError('DUPLICATE', 'That person is already on the register', 409);
  }
  throw error;
}

function assertEditable(actor, person) {
  if (Number(person.user_id) === Number(actor.userId)) {
    throw new VaultError('PROTECTED_USER', 'You cannot change your own register entry from this desk', 403);
  }
  if (isMasterAdmin(person) || person.system_role === 'IT_SUPER_ADMIN') {
    throw new VaultError('PROTECTED_USER', 'The IT super admin account stays on the register', 403);
  }
}

async function assertBranch(db, tenantId, branchId) {
  const id = Number(branchId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new VaultError('UNKNOWN_BRANCH', 'Choose a branch');
  }
  const row = await db.query(
    `SELECT branch_id, branch_name, branch_code
     FROM branches
     WHERE tenant_id = $1 AND branch_id = $2`,
    [tenantId, id],
  );
  if (!row.rowCount) throw new VaultError('UNKNOWN_BRANCH', 'That branch is not on this bank', 404);
  return row.rows[0];
}

async function loadPerson(db, tenantId, userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new VaultError('NOT_FOUND', 'That person is not on the register', 404);
  }
  const result = await db.query(
    `SELECT user_id, work_email, full_legal_name, employee_id, two_letter_initials,
            system_role, branch_id, is_active, closing_pin_hash
     FROM nodevault_users
     WHERE user_id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  if (!result.rowCount) throw new VaultError('NOT_FOUND', 'That person is not on the register', 404);
  return result.rows[0];
}

async function openAssignments(db, tenantId, userId, today) {
  const result = await db.query(
    `SELECT assignment_id, post_code, branch_id,
            period_start::text AS period_start, period_end::text AS period_end
     FROM post_assignments
     WHERE tenant_id = $1 AND user_id = $2 AND period_end >= $3::date
     ORDER BY period_start`,
    [tenantId, userId, today],
  );
  return result.rows;
}

function hashRounds() {
  const rounds = Number(process.env.PIN_BCRYPT_ROUNDS || 10);
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 12) return 10;
  return rounds;
}

async function listStaff(db, actor, now = new Date()) {
  const access = await staffAccess(db, actor);
  const today = todayIso(now);
  const windowStart = addDays(today, -14);
  const [branches, users, assignments] = await Promise.all([
    db.query(
      `SELECT branch_id, branch_code, branch_name
       FROM branches
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY branch_code`,
      [actor.tenantId],
    ),
    db.query(
      `SELECT u.user_id, u.full_legal_name, u.work_email, u.employee_id,
              u.two_letter_initials, u.system_role, u.branch_id, u.is_active,
              b.branch_name, b.branch_code
       FROM nodevault_users u
       LEFT JOIN branches b ON b.branch_id = u.branch_id AND b.tenant_id = u.tenant_id
       WHERE u.tenant_id = $1
       ORDER BY u.is_active DESC, u.full_legal_name`,
      [actor.tenantId],
    ),
    db.query(
      `SELECT a.assignment_id, a.user_id, a.post_code, a.branch_id,
              a.period_start::text AS period_start, a.period_end::text AS period_end,
              b.branch_name
       FROM post_assignments a
       JOIN branches b ON b.branch_id = a.branch_id AND b.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1 AND a.period_end >= $2::date
       ORDER BY a.period_start, a.post_code`,
      [actor.tenantId, windowStart],
    ),
  ]);
  const homeBranchId = actor.branchId === null || actor.branchId === undefined
    ? null
    : Number(actor.branchId);
  let branchSource = branches.rows;
  let userSource = users.rows;
  if (access.scoped) {
    branchSource = branchSource.filter((row) => Number(row.branch_id) === homeBranchId);
    userSource = userSource.filter((row) => Number(row.branch_id) === homeBranchId);
  }
  const branchRows = branchSource.map((row) => ({
    branch_id: Number(row.branch_id),
    branch_code: row.branch_code,
    branch_name: row.branch_name,
  }));
  branchRows.sort((left, right) => {
    if (homeBranchId !== null) {
      if (left.branch_id === homeBranchId) return -1;
      if (right.branch_id === homeBranchId) return 1;
    }
    return String(left.branch_code).localeCompare(String(right.branch_code));
  });
  const byUser = new Map();
  for (const row of assignments.rows) {
    const spec = POSTS.find((post) => post.code === row.post_code);
    const list = byUser.get(Number(row.user_id)) || [];
    let coverage = 'recent';
    if (row.period_start <= today && row.period_end >= today) coverage = 'current';
    else if (row.period_start > today) coverage = 'upcoming';
    list.push({
      assignment_id: Number(row.assignment_id),
      post_code: row.post_code,
      label: spec ? spec.label : row.post_code,
      branch_id: Number(row.branch_id),
      branch_name: row.branch_name,
      period_start: row.period_start,
      period_end: row.period_end,
      coverage,
    });
    byUser.set(Number(row.user_id), list);
  }
  const listed = await catalogue(db, actor.tenantId);
  const assignable = access.level === 'branch' ? listed.filter((role) => managerMayAssign(role)) : listed;
  return {
    can_manage: access.level === 'manage',
    can_edit_roles: access.level === 'branch',
    today,
    home_branch_id: homeBranchId,
    branches: branchRows,
    roles: listed.map((role) => ({
      code: role.code, label: role.label, pin: role.pin, builtin: role.builtin, tier: role.tier,
    })),
    assignable_roles: assignable.map((role) => ({
      code: role.code, label: role.label, pin: role.pin, builtin: role.builtin, tier: role.tier,
    })),
    posts: POSTS.map((post) => ({ code: post.code, label: post.label, role: post.role })),
    users: userSource.map((row) => ({
      user_id: Number(row.user_id),
      full_legal_name: row.full_legal_name,
      work_email: row.work_email,
      employee_id: row.employee_id,
      two_letter_initials: row.two_letter_initials,
      system_role: row.system_role,
      branch_id: row.branch_id === null ? null : Number(row.branch_id),
      branch_name: row.branch_name,
      branch_code: row.branch_code,
      is_active: row.is_active,
      protected: isMasterAdmin(row) || row.system_role === 'IT_SUPER_ADMIN',
      assignments: byUser.get(Number(row.user_id)) || [],
    })),
  };
}

async function addStaff(db, actor, body) {
  assertManager(actor);
  const name = cleanName(body.full_legal_name);
  const email = cleanEmail(body.work_email);
  const employeeId = cleanEmployee(body.employee_id);
  const initials = cleanInitials(body.two_letter_initials);
  const role = await assertRole(db, actor.tenantId, body.system_role);
  const branch = await assertBranch(db, actor.tenantId, body.branch_id);
  const pin = assertPin(body.closing_pin, role.pin);
  const password = assertPassword(body.password, pin);
  const rounds = hashRounds();
  const passwordHash = await bcrypt.hash(password, rounds);
  const pinHash = pin ? await bcrypt.hash(pin, rounds) : null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO nodevault_users (
         tenant_id, branch_id, work_email, full_legal_name, employee_id,
         two_letter_initials, system_role, closing_pin_hash, password_hash, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       RETURNING user_id`,
      [
        actor.tenantId,
        branch.branch_id,
        email,
        name,
        employeeId,
        initials,
        role.code,
        pinHash,
        passwordHash,
      ],
    );
    const userId = Number(inserted.rows[0].user_id);
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'STAFF_ADDED',
      actorUserIds: [actor.userId],
      detail: {
        user_id: userId,
        work_email: email,
        employee_id: employeeId,
        system_role: role.code,
        branch_id: Number(branch.branch_id),
      },
    });
    await client.query('COMMIT');
    return {
      user_id: userId,
      full_legal_name: name,
      work_email: email,
      employee_id: employeeId,
      two_letter_initials: initials,
      system_role: role.code,
      branch_id: Number(branch.branch_id),
      is_active: true,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw rethrowStaff(error);
  } finally {
    client.release();
  }
}

async function updateStaff(db, actor, userId, body, now = new Date()) {
  const access = await staffAccess(db, actor);
  if (access.level === 'read') {
    throw new VaultError('WRONG_ROLE', 'Only the master admin can change the staff register', 403);
  }
  const person = await loadPerson(db, actor.tenantId, userId);
  assertEditable(actor, person);
  if (access.level === 'branch') {
    const keys = Object.keys(body).filter((key) => body[key] !== undefined);
    if (keys.some((key) => key !== 'system_role')) {
      throw new VaultError(
        'WRONG_ROLE',
        'A branch manager can change the role of people already on this branch',
        403,
      );
    }
    if (Number(person.branch_id) !== Number(actor.branchId)) {
      throw new VaultError('WRONG_BRANCH', 'That person is on another branch', 403);
    }
  }
  const today = todayIso(now);
  const held = await openAssignments(db, actor.tenantId, person.user_id, today);
  const next = {};
  if (Object.prototype.hasOwnProperty.call(body, 'full_legal_name')) {
    next.full_legal_name = cleanName(body.full_legal_name);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'employee_id')) {
    next.employee_id = cleanEmployee(body.employee_id);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'two_letter_initials')) {
    next.two_letter_initials = cleanInitials(body.two_letter_initials);
  }
  let nextRole = await describeRole(db, actor.tenantId, person.system_role);
  if (Object.prototype.hasOwnProperty.call(body, 'system_role')) {
    nextRole = await assertRole(db, actor.tenantId, body.system_role);
    if (access.level === 'branch') {
      const current = await describeRole(db, actor.tenantId, person.system_role);
      if (!managerMayAssign(current) || !managerMayAssign(nextRole)) {
        throw new VaultError(
          'INVALID_ROLE',
          'A branch manager can change the role of tellers and branch roles already on this branch',
          403,
        );
      }
    }
    if (nextRole.code !== person.system_role && held.some((row) => {
      const spec = POSTS.find((post) => post.code === row.post_code);
      return spec && spec.role !== nextRole.code;
    })) {
      throw new VaultError(
        'POST_HELD',
        'Reassign the vault post before changing this role',
        409,
      );
    }
    next.system_role = nextRole.code;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'branch_id')) {
    const branch = await assertBranch(db, actor.tenantId, body.branch_id);
    if (Number(branch.branch_id) !== Number(person.branch_id) && held.some((row) => Number(row.branch_id) !== Number(branch.branch_id))) {
      throw new VaultError(
        'POST_HELD',
        'Reassign the vault post before moving this person to another branch',
        409,
      );
    }
    next.branch_id = Number(branch.branch_id);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
    if (typeof body.is_active !== 'boolean') {
      throw new VaultError('INVALID_STATUS', 'Say whether this person stays on the desk');
    }
    if (body.is_active === false && held.length) {
      throw new VaultError(
        'POST_HELD',
        'Reassign the vault post before removing this person',
        409,
      );
    }
    next.is_active = body.is_active;
  }
  let pin = null;
  if (Object.prototype.hasOwnProperty.call(body, 'closing_pin') && String(body.closing_pin || '').trim()) {
    pin = assertPin(body.closing_pin, true);
  }
  const roleNeedsPin = Boolean(nextRole && nextRole.pin);
  if (roleNeedsPin && !person.closing_pin_hash && !pin && next.is_active !== false) {
    throw new VaultError('INVALID_PIN', 'The closing PIN must be 4 to 8 digits');
  }
  let password = null;
  if (Object.prototype.hasOwnProperty.call(body, 'password') && String(body.password || '').length) {
    password = assertPassword(body.password, pin);
  }
  if (!Object.keys(next).length && !pin && !password) {
    throw new VaultError('INVALID_NAME', 'Nothing on this person was changed');
  }
  const rounds = hashRounds();
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(next)) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (pin) {
    values.push(await bcrypt.hash(pin, rounds));
    sets.push(`closing_pin_hash = $${values.length}`);
  }
  if (password) {
    values.push(await bcrypt.hash(password, rounds));
    sets.push(`password_hash = $${values.length}`);
    sets.push('failed_login_count = 0');
    sets.push('locked_until = NULL');
  }
  values.push(person.user_id, actor.tenantId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE nodevault_users SET ${sets.join(', ')}
       WHERE user_id = $${values.length - 1} AND tenant_id = $${values.length}`,
      values,
    );
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: next.is_active === false ? 'STAFF_REMOVED' : 'STAFF_UPDATED',
      actorUserIds: [actor.userId],
      detail: {
        user_id: Number(person.user_id),
        fields: [...Object.keys(next), pin ? 'closing_pin' : null, password ? 'password' : null].filter(Boolean),
      },
    });
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw rethrowStaff(error);
  } finally {
    client.release();
  }
  const saved = await loadPerson(db, actor.tenantId, person.user_id);
  return {
    user_id: Number(saved.user_id),
    full_legal_name: saved.full_legal_name,
    work_email: saved.work_email,
    employee_id: saved.employee_id,
    two_letter_initials: saved.two_letter_initials,
    system_role: saved.system_role,
    branch_id: saved.branch_id === null ? null : Number(saved.branch_id),
    is_active: saved.is_active,
  };
}

async function removeStaff(db, actor, userId, now = new Date()) {
  return updateStaff(db, actor, userId, { is_active: false }, now);
}

async function assignPost(db, actor, body, now = new Date()) {
  assertManager(actor);
  const start = assertIso(body.period_start, 'The start date');
  const end = assertIso(body.period_end, 'The end date');
  if (end < start) throw new VaultError('WRONG_DATE', 'The end date must be on or after the start date');
  if (diffDays(end, start) > 366) {
    throw new VaultError('WRONG_DATE', 'An assignment can cover at most 366 days');
  }
  const spec = POSTS.find((post) => post.code === body.post_code);
  if (!spec) throw new VaultError('UNKNOWN_POST', 'Choose a vault post');
  const branch = await assertBranch(db, actor.tenantId, body.branch_id);
  const person = await loadPerson(db, actor.tenantId, body.user_id);
  assertEditable(actor, person);
  if (!person.is_active) {
    throw new VaultError('INACTIVE_USER', 'Restore this person before assigning a post', 409);
  }
  if (person.system_role !== spec.role) {
    const expected = await describeRole(db, actor.tenantId, spec.role);
    throw new VaultError(
      'WRONG_ROLE',
      `${spec.label} must be an active ${expected ? expected.label.toLowerCase() : 'matching role'}`,
      403,
    );
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const overlaps = await client.query(
      `SELECT assignment_id, period_start::text AS period_start, period_end::text AS period_end
       FROM post_assignments
       WHERE tenant_id = $1 AND branch_id = $2 AND post_code = $3
         AND period_start <= $5::date AND period_end >= $4::date
       ORDER BY period_start
       FOR UPDATE`,
      [actor.tenantId, branch.branch_id, spec.code, start, end],
    );
    for (const row of overlaps.rows) {
      if (row.period_start < start) {
        await client.query(
          `UPDATE post_assignments SET period_end = $1::date WHERE assignment_id = $2`,
          [addDays(start, -1), row.assignment_id],
        );
      } else {
        throw new VaultError(
          'ASSIGNMENT_OVERLAP',
          `That post is already assigned from ${row.period_start}. Choose a later start.`,
          409,
        );
      }
    }
    const inserted = await client.query(
      `INSERT INTO post_assignments
         (tenant_id, branch_id, post_code, user_id, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING assignment_id`,
      [actor.tenantId, branch.branch_id, spec.code, person.user_id, start, end],
    );
    if (Number(person.branch_id) !== Number(branch.branch_id)) {
      await client.query(
        `UPDATE nodevault_users SET branch_id = $1 WHERE user_id = $2 AND tenant_id = $3`,
        [branch.branch_id, person.user_id, actor.tenantId],
      );
    }
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'STAFF_ASSIGNED',
      actorUserIds: [actor.userId],
      detail: {
        user_id: Number(person.user_id),
        post_code: spec.code,
        branch_id: Number(branch.branch_id),
        period_start: start,
        period_end: end,
      },
    });
    await client.query('COMMIT');
    return {
      assignment_id: Number(inserted.rows[0].assignment_id),
      user_id: Number(person.user_id),
      post_code: spec.code,
      branch_id: Number(branch.branch_id),
      period_start: start,
      period_end: end,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw rethrowStaff(error);
  } finally {
    client.release();
  }
}

module.exports = {
  ROLES,
  listStaff,
  addStaff,
  updateStaff,
  removeStaff,
  assignPost,
};
