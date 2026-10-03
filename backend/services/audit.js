async function recordAudit(db, {
  tenantId,
  eventType,
  bookId = null,
  actorUserIds = [],
  detail = {},
}) {
  await db.query(
    `INSERT INTO audit_events (tenant_id, event_type, book_id, actor_user_ids, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tenantId, eventType, bookId, actorUserIds, JSON.stringify(detail)],
  );
}

module.exports = { recordAudit };
