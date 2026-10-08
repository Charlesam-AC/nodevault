const bcrypt = require('bcryptjs');
const { VaultError } = require('./errors');
const { recordAudit } = require('./audit');
const { loadRows, amountsFromCells, composeRow, positionByCurrency } = require('./ledger');
const { figuresFromMinors, takeoverSentence, formatStamp, nameList } = require('./narration');
const {
  calendarOptions,
  periodContaining,
  addDays,
  upcomingBusinessDate,
  previousBusinessDay,
  zonedParts,
} = require('./calendar');
const { optionsForBranch } = require('./closures');
const { BOOK_ORDER } = require('./books');

const POSTS = [
  { code: 'CUSTODIAN_ONE', role: 'VAULT_CUSTODIAN', label: 'Vault custodian, seat 1' },
  { code: 'CUSTODIAN_TWO', role: 'VAULT_CUSTODIAN', label: 'Vault custodian, seat 2' },
  { code: 'HEAD_TELLER', role: 'HEAD_TELLER_COORDINATOR', label: 'Head Teller' },
];

function postSpec(code) {
  const spec = POSTS.find((post) => post.code === code);
  if (!spec) throw new VaultError('UNKNOWN_POST', `Unknown rotation post ${code}`);
  return spec;
}

async function pinMatches(pin, hash) {
  if (typeof pin !== 'string' || pin.length < 4 || pin.length > 32 || !hash) return false;
  return bcrypt.compare(pin, hash);
}

async function loadSchedules(db, tenantId, branchId) {
  const result = await db.query(
    `SELECT post_code, cadence, custom_days, anchor_date::text AS anchor_date
     FROM rotation_schedules
     WHERE tenant_id = $1 AND branch_id = $2
     ORDER BY post_code`,
    [tenantId, branchId],
  );
  return result.rows;
}

async function assignmentCovering(db, tenantId, branchId, postCode, isoDate) {
  const result = await db.query(
    `SELECT a.assignment_id, a.post_code, a.user_id, a.period_start::text AS period_start,
            a.period_end::text AS period_end, a.handover_id,
            u.full_legal_name, u.employee_id, u.two_letter_initials, u.system_role, u.work_email
     FROM post_assignments a
     JOIN nodevault_users u ON u.user_id = a.user_id AND u.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.branch_id = $2 AND a.post_code = $3
       AND a.period_start <= $4::date AND a.period_end >= $4::date`,
    [tenantId, branchId, postCode, isoDate],
  );
  return result.rows[0] || null;
}

async function holdersForDate(db, tenantId, branchId, isoDate) {
  const holders = {};
  const missing = [];
  for (const post of POSTS) {
    const row = await assignmentCovering(db, tenantId, branchId, post.code, isoDate);
    if (!row) missing.push(post.code);
    else holders[post.code] = row;
  }
  return {
    open: missing.length === 0,
    missing,
    holders,
  };
}

async function rotationView(db, tenantId, branchId, now = new Date(), overrides = {}) {
  const options = calendarOptions(overrides);
  const today = zonedParts(now, options.timeZone).isoDate;
  const schedules = await loadSchedules(db, tenantId, branchId);
  const posts = [];
  for (const schedule of schedules) {
    const spec = postSpec(schedule.post_code);
    const period = periodContaining(schedule, today);
    const currentRow = period
      ? await assignmentCovering(db, tenantId, branchId, schedule.post_code, today)
      : null;
    const next = period ? periodContaining(schedule, addDays(period.periodEnd, 1)) : null;
    const nextRow = next
      ? await assignmentCovering(db, tenantId, branchId, schedule.post_code, next.periodStart)
      : null;
    const current = currentRow
      ? publicHolder(currentRow)
      : (period ? { periodStart: period.periodStart, periodEnd: period.periodEnd, unassigned: true } : null);
    const upcoming = nextRow
      ? publicHolder(nextRow)
      : (next ? { periodStart: next.periodStart, periodEnd: next.periodEnd, unassigned: true } : null);
    posts.push({
      postCode: schedule.post_code,
      label: spec.label,
      role: spec.role,
      cadence: schedule.cadence,
      customDays: schedule.custom_days,
      anchorDate: schedule.anchor_date,
      current,
      next: upcoming,
    });
  }
  const dueDate = earliestDue(posts);
  const due = [];
  if (dueDate) {
    for (const post of posts) {
      const slot = [post.current, post.next].find((item) => item && item.unassigned && item.periodStart === dueDate);
      if (!slot) continue;
      const outgoing = await assignmentCovering(db, tenantId, branchId, post.postCode, addDays(dueDate, -1));
      due.push({
        postCode: post.postCode,
        label: post.label,
        role: post.role,
        effectiveDate: slot.periodStart,
        periodEnd: slot.periodEnd,
        outgoing: outgoing ? publicHolder(outgoing) : null,
      });
    }
  }
  return {
    today,
    upcomingBusinessDate: upcomingBusinessDate(now, options),
    dueDate,
    due,
    posts,
  };
}

function publicHolder(row) {
  return {
    userId: Number(row.user_id),
    fullLegalName: row.full_legal_name,
    employeeId: row.employee_id,
    initials: row.two_letter_initials,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    unassigned: false,
  };
}

function earliestDue(posts) {
  const dates = [];
  for (const post of posts) {
    for (const slot of [post.current, post.next]) {
      if (slot && slot.unassigned) dates.push(slot.periodStart);
    }
  }
  dates.sort();
  return dates[0] || null;
}

async function lockedCarrySnapshot(db, tenantId, branchId, businessDate) {
  const balances = {};
  for (const bookClass of BOOK_ORDER) {
    const book = await db.query(
      `SELECT book_id, status
       FROM branch_vault_books
       WHERE tenant_id = $1 AND branch_id = $2 AND book_class = $3 AND business_date = $4`,
      [tenantId, branchId, bookClass, businessDate],
    );
    if (book.rowCount !== 1 || book.rows[0].status !== 'BALANCED_CLOSED') {
      throw new VaultError(
        'HANDOVER_UNCLOSED',
        `Handover needs a locked ${bookClass} book for ${businessDate}`,
        409,
      );
    }
    const rows = await loadRows(db, book.rows[0].book_id);
    const carried = [...rows].reverse().find((row) => row.accountingLabel === 'Bal c/d' && row.flowDirection === 'BAL');
    if (!carried) {
      throw new VaultError('HANDOVER_UNCLOSED', `No Bal c/d on the locked ${bookClass} book`, 409);
    }
    balances[bookClass] = amountsFromCells(carried.cells);
  }
  return balances;
}

async function captureHandover(db, {
  tenantId,
  branchId,
  effectiveDate,
  posts,
  at = new Date(),
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate || '')) {
    throw new VaultError('HANDOVER_DATE', 'Effective date must be YYYY-MM-DD');
  }
  const schedules = await loadSchedules(db, tenantId, branchId);
  const expected = [];
  for (const schedule of schedules) {
    const period = periodContaining(schedule, effectiveDate);
    if (!period || period.periodStart !== effectiveDate) continue;
    const existing = await assignmentCovering(db, tenantId, branchId, schedule.post_code, effectiveDate);
    if (existing) continue;
    const outgoing = await assignmentCovering(db, tenantId, branchId, schedule.post_code, addDays(effectiveDate, -1));
    if (!outgoing) {
      throw new VaultError('HANDOVER_SOURCE', `No outgoing holder for ${schedule.post_code}`, 409);
    }
    expected.push({ schedule, period, outgoing });
  }
  if (expected.length === 0) {
    throw new VaultError('HANDOVER_NOT_DUE', 'No rotation post changes on that effective date', 409);
  }
  const submitted = new Map((posts || []).map((post) => [post.postCode || post.post_code, post]));
  if (submitted.size !== expected.length || expected.some((item) => !submitted.has(item.schedule.post_code))) {
    throw new VaultError('HANDOVER_POSTS', 'The handover must name every post that starts on the effective date', 400);
  }

  const priorDate = previousBusinessDay(
    effectiveDate,
    await optionsForBranch(db, tenantId, branchId, { anchorDate: effectiveDate }),
  );
  const balances = await lockedCarrySnapshot(db, tenantId, branchId, priorDate);
  const captured = [];
  for (const item of expected) {
    const body = submitted.get(item.schedule.post_code);
    const spec = postSpec(item.schedule.post_code);
    const incomingId = Number(body.incomingUserId || body.incoming_user_id);
    const incoming = await db.query(
      `SELECT user_id, full_legal_name, employee_id, two_letter_initials, system_role,
              closing_pin_hash, is_active
       FROM nodevault_users
       WHERE user_id = $1 AND tenant_id = $2`,
      [incomingId, tenantId],
    );
    const person = incoming.rows[0];
    if (!person || !person.is_active || person.system_role !== spec.role) {
      throw new VaultError('WRONG_ROLE', `${spec.label} must be an active ${spec.role}`, 403);
    }
    if (Number(person.user_id) === Number(item.outgoing.user_id)) {
      throw new VaultError('DUPLICATE_SIGNATORY', 'The incoming holder must be a different person', 400);
    }
    const employeeId = body.employeeId || body.employee_id;
    const initials = body.initials;
    if (employeeId !== person.employee_id || initials !== person.two_letter_initials) {
      throw new VaultError('HANDOVER_MISMATCH', 'Employee ID and initials must match the incoming holder', 400);
    }
    const outgoingUser = await db.query(
      `SELECT closing_pin_hash FROM nodevault_users WHERE user_id = $1 AND tenant_id = $2`,
      [item.outgoing.user_id, tenantId],
    );
    const outgoingPin = body.outgoingPin || body.outgoing_pin;
    const incomingPin = body.incomingPin || body.incoming_pin;
    const pinsOk = await Promise.all([
      pinMatches(outgoingPin, outgoingUser.rows[0].closing_pin_hash),
      pinMatches(incomingPin, person.closing_pin_hash),
    ]);
    if (pinsOk.some((ok) => !ok)) {
      throw new VaultError('WRONG_PIN', 'Access denied: auth failure', 401);
    }
    captured.push({
      postCode: item.schedule.post_code,
      period: item.period,
      outgoing: {
        userId: Number(item.outgoing.user_id),
        fullLegalName: item.outgoing.full_legal_name,
        employeeId: item.outgoing.employee_id,
        initials: item.outgoing.two_letter_initials,
        acknowledged: true,
      },
      incoming: {
        userId: Number(person.user_id),
        fullLegalName: person.full_legal_name,
        employeeId: person.employee_id,
        initials: person.two_letter_initials,
        acknowledged: true,
      },
    });
  }

  const stamp = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(stamp.getTime())) {
    throw new VaultError('HANDOVER_DATE', 'The takeover time is not a real date');
  }
  const detail = { effectiveDate, priorBusinessDate: priorDate, posts: captured, balances };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const log = await client.query(
      `INSERT INTO handover_logs (tenant_id, branch_id, effective_date, balances, detail, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       RETURNING handover_id`,
      [tenantId, branchId, effectiveDate, JSON.stringify(balances), JSON.stringify(detail), stamp.toISOString()],
    );
    const handoverId = log.rows[0].handover_id;
    for (const post of captured) {
      await client.query(
        `INSERT INTO post_assignments
           (tenant_id, branch_id, post_code, user_id, period_start, period_end, handover_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          branchId,
          post.postCode,
          post.incoming.userId,
          post.period.periodStart,
          post.period.periodEnd,
          handoverId,
        ],
      );
    }
    await recordAudit(client, {
      tenantId,
      eventType: 'HANDOVER_CAPTURED',
      actorUserIds: [...new Set(captured.flatMap((post) => [post.outgoing.userId, post.incoming.userId]))],
      detail,
    });
    const narrations = await writeTakeoverNarrations(client, {
      tenantId,
      branchId,
      handoverId,
      effectiveDate,
      captured,
      balances,
      at: stamp,
    });
    await client.query('COMMIT');
    return { handoverId: Number(handoverId), effectiveDate, balances, posts: captured, narrations };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* already aborted */ }
    throw error;
  } finally {
    client.release();
  }
}

async function writeTakeoverNarrations(client, {
  tenantId,
  branchId,
  handoverId,
  effectiveDate,
  captured,
  balances,
  at,
}) {
  const seat = (code) => captured.find((post) => post.postCode === code);
  const incomingOne = seat('CUSTODIAN_ONE');
  const incomingTwo = seat('CUSTODIAN_TWO');
  if (!incomingOne || !incomingTwo) return [];
  const incoming = [incomingOne.incoming, incomingTwo.incoming];
  const outgoing = [incomingOne.outgoing, incomingTwo.outgoing];
  const narrations = [];
  for (const bookClass of BOOK_ORDER) {
    const cells = composeRow(bookClass, { amounts: balances[bookClass] });
    const figures = figuresFromMinors(bookClass, positionByCurrency(bookClass, cells));
    const text = takeoverSentence({ figures, incoming, outgoing, at });
    await client.query(
      `INSERT INTO book_narrations (
         tenant_id, branch_id, handover_id, book_class, business_date, narration_text, totals
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [tenantId, branchId, handoverId, bookClass, effectiveDate, text, JSON.stringify(figures)],
    );
    narrations.push({ book_class: bookClass, narration_text: text, totals: figures });
  }
  await recordAudit(client, {
    tenantId,
    eventType: 'TAKEOVER_NARRATED',
    actorUserIds: [...new Set(incoming.concat(outgoing).map((person) => person.userId))],
    detail: {
      handover_id: Number(handoverId),
      business_date: effectiveDate,
      narrations: narrations.map((item) => ({
        book_class: item.book_class,
        narration_text: item.narration_text,
      })),
    },
  });
  return narrations;
}

async function takeoverSlip(db, tenantId, handoverId) {
  const result = await db.query(
    `SELECT h.handover_id, h.branch_id, h.effective_date::text AS effective_date,
            h.created_at, h.detail,
            br.branch_name, br.branch_code, t.bank_name, t.logo_label
     FROM handover_logs h
     JOIN branches br ON br.branch_id = h.branch_id AND br.tenant_id = h.tenant_id
     JOIN bank_tenants t ON t.tenant_id = h.tenant_id
     WHERE h.handover_id = $1 AND h.tenant_id = $2`,
    [handoverId, tenantId],
  );
  if (result.rowCount !== 1) {
    throw new VaultError('HANDOVER_NOT_FOUND', 'That handover is not on this bank', 404);
  }
  const log = result.rows[0];
  const narrations = await db.query(
    `SELECT book_class, narration_text, totals
     FROM book_narrations
     WHERE handover_id = $1`,
    [handoverId],
  );
  if (narrations.rowCount === 0) {
    throw new VaultError('NO_NARRATION', 'That handover did not write a takeover narration', 404);
  }
  const posts = log.detail.posts || [];
  const seat = (code) => posts.find((post) => post.postCode === code);
  const books = BOOK_ORDER.map((bookClass) => {
    const row = narrations.rows.find((item) => item.book_class === bookClass);
    return {
      book_class: bookClass,
      narration_text: row.narration_text,
      totals: row.totals,
    };
  });
  let headTeller = seat('HEAD_TELLER');
  if (!headTeller) {
    const covering = await assignmentCovering(
      db, tenantId, log.branch_id, 'HEAD_TELLER', log.effective_date,
    );
    headTeller = covering ? {
      incoming: {
        fullLegalName: covering.full_legal_name,
        employeeId: covering.employee_id,
      },
    } : null;
  }
  return {
    handover_id: Number(log.handover_id),
    bank_name: log.bank_name,
    logo_label: log.logo_label,
    branch_name: log.branch_name,
    branch_code: log.branch_code,
    effective_date: log.effective_date,
    taken_over_at: formatStamp(log.created_at),
    handing_over: [seat('CUSTODIAN_ONE').outgoing, seat('CUSTODIAN_TWO').outgoing],
    taking_over: [seat('CUSTODIAN_ONE').incoming, seat('CUSTODIAN_TWO').incoming],
    head_teller: headTeller ? {
      fullLegalName: headTeller.incoming.fullLegalName,
      employeeId: headTeller.incoming.employeeId,
    } : null,
    books,
    signature_names: nameList([seat('CUSTODIAN_ONE').incoming, seat('CUSTODIAN_TWO').incoming]),
  };
}

module.exports = {
  POSTS,
  holdersForDate,
  assignmentCovering,
  rotationView,
  captureHandover,
  lockedCarrySnapshot,
  takeoverSlip,
};
