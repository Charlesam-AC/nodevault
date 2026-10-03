const { VaultError } = require('./errors');
const { recordAudit } = require('./audit');
const { addDays, calendarOptions, zonedParts } = require('./calendar');
const { holidayDates, zambiaHolidays } = require('./zambiaHolidays');

const OPS_ROLE = 'REGIONAL_OPS_MANAGER';

function assertOps(actor) {
  if (!actor || actor.role !== OPS_ROLE) {
    throw new VaultError(
      'FORBIDDEN',
      'Only a regional operations manager can change non-working days.',
      403,
    );
  }
}

function businessToday(now, overrides = {}) {
  const options = calendarOptions(overrides);
  return zonedParts(now || new Date(), options.timeZone).isoDate;
}

function assertRange(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
    throw new VaultError('CLOSURE_DATE', 'Dates must be YYYY-MM-DD');
  }
  if (endDate < startDate) throw new VaultError('CLOSURE_DATE', 'The end date is before the start date');
  const span = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
  if (span > 62) throw new VaultError('CLOSURE_DATE', 'A closure can cover at most 62 days');
}

function eachDate(startDate, endDate) {
  const dates = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

async function branchRow(db, tenantId, branchId) {
  const result = await db.query(
    `SELECT branch_id, branch_code, branch_name, province, location_name
     FROM branches
     WHERE tenant_id = $1 AND branch_id = $2`,
    [tenantId, branchId],
  );
  return result.rows[0] || null;
}

async function branchesInScope(db, tenantId, scope, { province, locationName, branchIds }) {
  if (scope === 'TENANT') {
    const result = await db.query(
      `SELECT branch_id, branch_code, branch_name, province, location_name
       FROM branches WHERE tenant_id = $1 ORDER BY branch_code`,
      [tenantId],
    );
    return result.rows;
  }
  if (scope === 'PROVINCE') {
    const name = String(province || '').trim();
    if (!name) throw new VaultError('CLOSURE_SCOPE', 'Name the province');
    const result = await db.query(
      `SELECT branch_id, branch_code, branch_name, province, location_name
       FROM branches
       WHERE tenant_id = $1 AND lower(btrim(province)) = lower($2)
       ORDER BY branch_code`,
      [tenantId, name],
    );
    if (result.rowCount === 0) throw new VaultError('CLOSURE_SCOPE', `No branch is in ${name}`);
    return result.rows;
  }
  if (scope === 'LOCATION') {
    const name = String(locationName || '').trim();
    if (!name) throw new VaultError('CLOSURE_SCOPE', 'Name the location');
    const result = await db.query(
      `SELECT branch_id, branch_code, branch_name, province, location_name
       FROM branches
       WHERE tenant_id = $1 AND lower(btrim(location_name)) = lower($2)
       ORDER BY branch_code`,
      [tenantId, name],
    );
    if (result.rowCount === 0) throw new VaultError('CLOSURE_SCOPE', `No branch is at ${name}`);
    return result.rows;
  }
  if (scope === 'BRANCH') {
    const ids = [...new Set((branchIds || []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) throw new VaultError('CLOSURE_SCOPE', 'Select at least one branch');
    const result = await db.query(
      `SELECT branch_id, branch_code, branch_name, province, location_name
       FROM branches
       WHERE tenant_id = $1 AND branch_id = ANY($2::int[])
       ORDER BY branch_code`,
      [tenantId, ids],
    );
    if (result.rowCount !== ids.length) throw new VaultError('CLOSURE_SCOPE', 'A selected branch is not in this bank');
    return result.rows;
  }
  throw new VaultError('CLOSURE_SCOPE', 'Scope must be all branches, a province, a location, or selected branches');
}

async function assertNoBooks(db, tenantId, branchIds, startDate, endDate) {
  const existing = await db.query(
    `SELECT br.branch_name, v.business_date::text AS business_date, v.book_class, v.status,
            EXISTS (
              SELECT 1 FROM vault_denomination_matrix_ledger l WHERE l.book_id = v.book_id
            ) AS has_lines
     FROM branch_vault_books v
     JOIN branches br ON br.branch_id = v.branch_id AND br.tenant_id = v.tenant_id
     WHERE v.tenant_id = $1
       AND v.branch_id = ANY($2::int[])
       AND v.business_date BETWEEN $3::date AND $4::date
     ORDER BY v.business_date, br.branch_name
     LIMIT 1`,
    [tenantId, branchIds, startDate, endDate],
  );
  const row = existing.rows[0];
  if (!row) return;
  const state = row.status === 'BALANCED_CLOSED'
    ? 'a closed book'
    : (row.has_lines ? 'an open book with transactions' : 'an open book');
  throw new VaultError(
    'CLOSURE_HAS_BOOKS',
    `${row.branch_name} already has ${state} (${row.book_class}) on ${row.business_date}. That day cannot be declared non-working.`,
    409,
  );
}

async function assertNoOverlap(db, tenantId, branchIds, startDate, endDate) {
  const overlap = await db.query(
    `SELECT c.closure_id, c.start_date::text AS start_date, c.end_date::text AS end_date, c.reason
     FROM non_working_closures c
     WHERE c.tenant_id = $1
       AND c.end_date >= $2::date
       AND c.start_date <= $3::date
       AND NOT EXISTS (
         SELECT 1 FROM non_working_closure_cancellations x WHERE x.closure_id = c.closure_id
       )
       AND (
         c.scope = 'TENANT'
         OR (c.scope = 'PROVINCE' AND EXISTS (
           SELECT 1 FROM branches b
           WHERE b.tenant_id = c.tenant_id AND b.branch_id = ANY($4::int[])
             AND lower(btrim(b.province)) = lower(btrim(c.province))
         ))
         OR (c.scope = 'LOCATION' AND EXISTS (
           SELECT 1 FROM branches b
           WHERE b.tenant_id = c.tenant_id AND b.branch_id = ANY($4::int[])
             AND lower(btrim(b.location_name)) = lower(btrim(c.location_name))
         ))
         OR (c.scope = 'BRANCH' AND EXISTS (
           SELECT 1 FROM non_working_closure_branches cb
           WHERE cb.closure_id = c.closure_id AND cb.branch_id = ANY($4::int[])
         ))
       )
     LIMIT 1`,
    [tenantId, startDate, endDate, branchIds],
  );
  if (overlap.rowCount === 0) return;
  const row = overlap.rows[0];
  throw new VaultError(
    'CLOSURE_OVERLAP',
    `Those branches already have a closure from ${row.start_date} to ${row.end_date}.`,
    409,
  );
}

async function declareClosure(db, actor, body) {
  assertOps(actor);
  const startDate = body.startDate || body.start_date;
  const endDate = body.endDate || body.end_date || startDate;
  assertRange(startDate, endDate);
  const today = businessToday(actor.now);
  if (startDate <= today) {
    throw new VaultError('CLOSURE_DATE', 'A closure has to start on a future business date', 409);
  }
  const reason = String(body.reason || '').trim();
  if (reason.length < 3 || reason.length > 400) {
    throw new VaultError('CLOSURE_REASON', 'Give a reason of 3 to 400 characters');
  }
  const scope = body.scope;
  const targets = await branchesInScope(db, actor.tenantId, scope, {
    province: body.province,
    locationName: body.locationName || body.location_name,
    branchIds: body.branchIds || body.branch_ids,
  });
  const branchIds = targets.map((row) => Number(row.branch_id));
  await assertNoBooks(db, actor.tenantId, branchIds, startDate, endDate);
  await assertNoOverlap(db, actor.tenantId, branchIds, startDate, endDate);

  const province = scope === 'PROVINCE' ? String(body.province).trim() : null;
  const locationName = scope === 'LOCATION' ? String(body.locationName || body.location_name).trim() : null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO non_working_closures
         (tenant_id, scope, province, location_name, reason, start_date, end_date, set_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING closure_id, created_at`,
      [actor.tenantId, scope, province, locationName, reason, startDate, endDate, actor.userId],
    );
    const closureId = inserted.rows[0].closure_id;
    if (scope === 'BRANCH') {
      for (const branchId of branchIds) {
        await client.query(
          `INSERT INTO non_working_closure_branches (closure_id, tenant_id, branch_id)
           VALUES ($1, $2, $3)`,
          [closureId, actor.tenantId, branchId],
        );
      }
    }
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'CLOSURE_DECLARED',
      actorUserIds: [actor.userId],
      detail: {
        closureId: Number(closureId),
        scope,
        province,
        locationName,
        branchIds,
        startDate,
        endDate,
        reason,
      },
    });
    await client.query('COMMIT');
    return {
      closureId: Number(closureId),
      scope,
      startDate,
      endDate,
      reason,
      setAt: inserted.rows[0].created_at,
      branchIds,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* already closed */ }
    throw error;
  } finally {
    client.release();
  }
}

async function cancelClosure(db, actor, closureId) {
  assertOps(actor);
  const id = Number(closureId);
  const found = await db.query(
    `SELECT c.closure_id, c.start_date::text AS start_date, c.scope,
            EXISTS (
              SELECT 1 FROM non_working_closure_cancellations x WHERE x.closure_id = c.closure_id
            ) AS cancelled
     FROM non_working_closures c
     WHERE c.closure_id = $1 AND c.tenant_id = $2`,
    [id, actor.tenantId],
  );
  const row = found.rows[0];
  if (!row) throw new VaultError('CLOSURE_MISSING', 'That closure is not on this bank', 404);
  if (row.cancelled) throw new VaultError('CLOSURE_CANCELLED', 'That closure is already cancelled', 409);
  const today = businessToday(actor.now);
  if (row.start_date <= today) {
    throw new VaultError('CLOSURE_STARTED', 'A closure can only be cancelled before it starts', 409);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO non_working_closure_cancellations
         (closure_id, tenant_id, cancelled_by_user_id)
       VALUES ($1, $2, $3)`,
      [id, actor.tenantId, actor.userId],
    );
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'CLOSURE_CANCELLED',
      actorUserIds: [actor.userId],
      detail: { closureId: id, startDate: row.start_date },
    });
    await client.query('COMMIT');
    return { closureId: id, cancelled: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* already closed */ }
    throw error;
  } finally {
    client.release();
  }
}

async function declareGazetted(db, actor, body) {
  assertOps(actor);
  const holidayDate = body.holidayDate || body.holiday_date;
  assertRange(holidayDate, holidayDate);
  const today = businessToday(actor.now);
  if (holidayDate <= today) {
    throw new VaultError('GAZETTE_DATE', 'A gazetted holiday has to be a future date', 409);
  }
  const name = String(body.name || '').trim();
  if (name.length < 3 || name.length > 160) throw new VaultError('GAZETTE_NAME', 'Name the holiday');
  const reference = String(body.gazetteReference || body.gazette_reference || '').trim() || null;
  await assertNoBooks(db, actor.tenantId,
    (await branchesInScope(db, actor.tenantId, 'TENANT', {})).map((row) => Number(row.branch_id)),
    holidayDate, holidayDate);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO gazetted_holidays
         (tenant_id, holiday_date, name, gazette_reference, set_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING holiday_id, created_at`,
      [actor.tenantId, holidayDate, name, reference, actor.userId],
    );
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'GAZETTE_DECLARED',
      actorUserIds: [actor.userId],
      detail: { holidayId: Number(inserted.rows[0].holiday_id), holidayDate, name, gazetteReference: reference },
    });
    await client.query('COMMIT');
    return {
      holidayId: Number(inserted.rows[0].holiday_id),
      holidayDate,
      name,
      gazetteReference: reference,
      setAt: inserted.rows[0].created_at,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* already closed */ }
    if (error.code === '23505') {
      throw new VaultError('GAZETTE_EXISTS', 'That gazetted holiday is already recorded', 409);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function cancelGazetted(db, actor, holidayId) {
  assertOps(actor);
  const id = Number(holidayId);
  const found = await db.query(
    `SELECT h.holiday_id, h.holiday_date::text AS holiday_date,
            EXISTS (
              SELECT 1 FROM gazetted_holiday_cancellations x WHERE x.holiday_id = h.holiday_id
            ) AS cancelled
     FROM gazetted_holidays h
     WHERE h.holiday_id = $1 AND h.tenant_id = $2`,
    [id, actor.tenantId],
  );
  const row = found.rows[0];
  if (!row) throw new VaultError('GAZETTE_MISSING', 'That gazetted holiday is not on this bank', 404);
  if (row.cancelled) throw new VaultError('GAZETTE_CANCELLED', 'That gazetted holiday is already cancelled', 409);
  const today = businessToday(actor.now);
  if (row.holiday_date <= today) {
    throw new VaultError('GAZETTE_STARTED', 'A gazetted holiday can only be cancelled before the date', 409);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO gazetted_holiday_cancellations (holiday_id, tenant_id, cancelled_by_user_id)
       VALUES ($1, $2, $3)`,
      [id, actor.tenantId, actor.userId],
    );
    await recordAudit(client, {
      tenantId: actor.tenantId,
      eventType: 'GAZETTE_CANCELLED',
      actorUserIds: [actor.userId],
      detail: { holidayId: id, holidayDate: row.holiday_date },
    });
    await client.query('COMMIT');
    return { holidayId: id, cancelled: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* already closed */ }
    throw error;
  } finally {
    client.release();
  }
}

async function closedDatesForBranch(db, tenantId, branchId, anchorDate) {
  const year = Number(String(anchorDate).slice(0, 4));
  const dates = [];
  for (const y of [year - 1, year, year + 1]) dates.push(...holidayDates(y));
  const branch = await branchRow(db, tenantId, branchId);
  const province = branch ? branch.province : null;
  const location = branch ? branch.location_name : null;
  const windowStart = `${year - 1}-01-01`;
  const windowEnd = `${year + 1}-12-31`;
  const closures = await db.query(
    `SELECT c.start_date::text AS start_date, c.end_date::text AS end_date
     FROM non_working_closures c
     WHERE c.tenant_id = $1
       AND c.end_date >= $2::date
       AND c.start_date <= $3::date
       AND NOT EXISTS (
         SELECT 1 FROM non_working_closure_cancellations x WHERE x.closure_id = c.closure_id
       )
       AND (
         c.scope = 'TENANT'
         OR (c.scope = 'PROVINCE' AND lower(btrim(c.province)) = lower(btrim($4)))
         OR (c.scope = 'LOCATION' AND lower(btrim(c.location_name)) = lower(btrim($5)))
         OR (c.scope = 'BRANCH' AND EXISTS (
           SELECT 1 FROM non_working_closure_branches cb
           WHERE cb.closure_id = c.closure_id AND cb.branch_id = $6
         ))
       )`,
    [tenantId, windowStart, windowEnd, province, location, branchId],
  );
  for (const row of closures.rows) {
    const start = row.start_date < windowStart ? windowStart : row.start_date;
    const end = row.end_date > windowEnd ? windowEnd : row.end_date;
    dates.push(...eachDate(start, end));
  }
  const gazetted = await db.query(
    `SELECT h.holiday_date::text AS holiday_date
     FROM gazetted_holidays h
     WHERE h.tenant_id = $1
       AND h.holiday_date BETWEEN $2::date AND $3::date
       AND NOT EXISTS (
         SELECT 1 FROM gazetted_holiday_cancellations x WHERE x.holiday_id = h.holiday_id
       )`,
    [tenantId, windowStart, windowEnd],
  );
  for (const row of gazetted.rows) dates.push(row.holiday_date);
  return dates;
}

async function optionsForBranch(db, tenantId, branchId, overrides = {}) {
  const options = calendarOptions(overrides);
  if (Object.prototype.hasOwnProperty.call(overrides, 'holidays')) return options;
  const anchor = overrides.anchorDate
    || zonedParts(overrides.now || new Date(), options.timeZone).isoDate;
  const extra = await closedDatesForBranch(db, tenantId, branchId, anchor);
  options.holidays = [...new Set([...(options.holidays || []), ...extra])].sort();
  return options;
}

async function calendarDesk(db, tenantId, branchId, actor, now = new Date()) {
  const options = calendarOptions();
  const today = zonedParts(now, options.timeZone).isoDate;
  const horizon = addDays(today, 120);
  const year = Number(today.slice(0, 4));
  const holidays = [year, year + 1]
    .flatMap((y) => zambiaHolidays(y))
    .filter((row) => row.date >= today && row.date <= horizon)
    .map((row) => ({
      date: row.date,
      name: row.name,
      observance: row.observance,
      statutoryDate: row.statutoryDate || null,
    }));
  const closures = await db.query(
    `SELECT c.closure_id, c.scope, c.province, c.location_name, c.reason,
            c.start_date::text AS start_date, c.end_date::text AS end_date,
            c.created_at, u.full_legal_name AS set_by,
            x.cancelled_at
     FROM non_working_closures c
     JOIN nodevault_users u ON u.user_id = c.set_by_user_id AND u.tenant_id = c.tenant_id
     LEFT JOIN non_working_closure_cancellations x ON x.closure_id = c.closure_id
     WHERE c.tenant_id = $1 AND c.end_date >= $2::date
     ORDER BY c.start_date, c.closure_id`,
    [tenantId, today],
  );
  const links = await db.query(
    `SELECT cb.closure_id, cb.branch_id, b.branch_code
     FROM non_working_closure_branches cb
     JOIN branches b ON b.branch_id = cb.branch_id AND b.tenant_id = cb.tenant_id
     WHERE cb.tenant_id = $1`,
    [tenantId],
  );
  const byClosure = new Map();
  for (const link of links.rows) {
    const list = byClosure.get(Number(link.closure_id)) || [];
    list.push({ branchId: Number(link.branch_id), branchCode: link.branch_code });
    byClosure.set(Number(link.closure_id), list);
  }
  const branch = branchId ? await branchRow(db, tenantId, branchId) : null;
  function applies(row) {
    if (row.cancelled_at) return false;
    if (row.scope === 'TENANT') return true;
    if (!branch) return false;
    if (row.scope === 'PROVINCE') return String(branch.province || '').toLowerCase() === String(row.province).toLowerCase();
    if (row.scope === 'LOCATION') return String(branch.location_name || '').toLowerCase() === String(row.location_name).toLowerCase();
    return (byClosure.get(Number(row.closure_id)) || []).some((item) => item.branchId === Number(branchId));
  }
  const gazetted = await db.query(
    `SELECT h.holiday_id, h.holiday_date::text AS holiday_date, h.name, h.gazette_reference,
            h.created_at, u.full_legal_name AS set_by, x.cancelled_at
     FROM gazetted_holidays h
     JOIN nodevault_users u ON u.user_id = h.set_by_user_id AND u.tenant_id = h.tenant_id
     LEFT JOIN gazetted_holiday_cancellations x ON x.holiday_id = h.holiday_id
     WHERE h.tenant_id = $1 AND h.holiday_date >= $2::date
     ORDER BY h.holiday_date`,
    [tenantId, today],
  );
  const directory = await db.query(
    `SELECT branch_id, branch_code, branch_name, province, location_name
     FROM branches WHERE tenant_id = $1 ORDER BY branch_code`,
    [tenantId],
  );
  let nonWorking = null;
  if (branchId) {
    const closed = new Set(await closedDatesForBranch(db, tenantId, branchId, today));
    if (closed.has(today)) {
      const named = holidays.find((row) => row.date === today)
        || gazetted.rows.find((row) => !row.cancelled_at && row.holiday_date === today);
      const closure = closures.rows.find((row) => applies(row) && row.start_date <= today && row.end_date >= today);
      nonWorking = {
        date: today,
        name: named ? named.name : (closure ? closure.reason : 'Non-working day'),
      };
    }
  }
  return {
    today,
    canManage: Boolean(actor && actor.role === OPS_ROLE),
    nonWorking,
    holidays,
    closures: closures.rows.map((row) => ({
      closureId: Number(row.closure_id),
      scope: row.scope,
      province: row.province,
      locationName: row.location_name,
      reason: row.reason,
      startDate: row.start_date,
      endDate: row.end_date,
      setBy: row.set_by,
      setAt: row.created_at,
      cancelled: Boolean(row.cancelled_at),
      appliesHere: applies(row),
      cancellable: !row.cancelled_at && row.start_date > today,
      branches: byClosure.get(Number(row.closure_id)) || [],
    })),
    gazetted: gazetted.rows.map((row) => ({
      holidayId: Number(row.holiday_id),
      date: row.holiday_date,
      name: row.name,
      gazetteReference: row.gazette_reference,
      setBy: row.set_by,
      setAt: row.created_at,
      cancelled: Boolean(row.cancelled_at),
      cancellable: !row.cancelled_at && row.holiday_date > today,
    })),
    branches: directory.rows.map((row) => ({
      branchId: Number(row.branch_id),
      branchCode: row.branch_code,
      branchName: row.branch_name,
      province: row.province,
      locationName: row.location_name,
    })),
  };
}

module.exports = {
  OPS_ROLE,
  declareClosure,
  cancelClosure,
  declareGazetted,
  cancelGazetted,
  closedDatesForBranch,
  optionsForBranch,
  calendarDesk,
  businessToday,
};
