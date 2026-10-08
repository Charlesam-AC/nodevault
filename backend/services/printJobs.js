const { VaultError } = require('./errors');
const { recordAudit } = require('./audit');
const { triggerSilentPrinter } = require('./print');

async function branchTarget(db, tenantId, branchId) {
  const result = await db.query(
    `SELECT printer_target FROM branches WHERE tenant_id = $1 AND branch_id = $2`,
    [tenantId, branchId],
  );
  if (!result.rowCount) throw new VaultError('NOT_FOUND', 'That branch is not on this bank', 404);
  return result.rows[0].printer_target;
}

// Sends a PDF after the business action has committed. A failure does not undo that action.
async function deliver(db, {
  tenantId,
  branchId,
  documentKind,
  sourceRef,
  pdf,
  bookId = null,
  deps = {},
}) {
  const printerTarget = await branchTarget(db, tenantId, branchId);
  const inserted = await db.query(
    `INSERT INTO print_jobs (
       tenant_id, branch_id, document_kind, source_ref, printer_target, status
     ) VALUES ($1,$2,$3,$4,$5,'PENDING')
     RETURNING job_id`,
    [tenantId, branchId, documentKind, String(sourceRef), printerTarget],
  );
  const jobId = Number(inserted.rows[0].job_id);
  const payload = {
    branchId: Number(branchId),
    printerTarget,
    documentKind,
    jobId,
    pdf_base64: pdf.toString('base64'),
  };
  if (bookId) payload.bookId = Number(bookId);
  try {
    const printer = deps.printer || triggerSilentPrinter;
    const result = await printer(payload);
    await db.query(
      `UPDATE print_jobs
       SET status = 'SENT', attempts = attempts + 1, last_error = NULL, sent_at = now(), printer_target = $2
       WHERE job_id = $1`,
      [jobId, printerTarget],
    );
    await recordAudit(db, {
      tenantId,
      eventType: 'PRINT_SENT',
      bookId,
      actorUserIds: [],
      detail: {
        document_kind: documentKind,
        source_ref: String(sourceRef),
        job_id: jobId,
        printer_target: printerTarget,
      },
    });
    return { status: 'SENT', job_id: jobId, file: result && result.file ? result.file : null, printer_target: printerTarget };
  } catch (error) {
    const message = String(error.message || error).slice(0, 500);
    await db.query(
      `UPDATE print_jobs
       SET status = 'FAILED', attempts = attempts + 1, last_error = $2
       WHERE job_id = $1`,
      [jobId, message],
    );
    await recordAudit(db, {
      tenantId,
      eventType: 'DISPATCH_FAILED',
      bookId,
      actorUserIds: [],
      detail: { document_kind: documentKind, source_ref: String(sourceRef), job_id: jobId, error: message },
    });
    return { status: 'FAILED', job_id: jobId, error: message, printer_target: printerTarget };
  }
}

module.exports = { deliver, branchTarget };
