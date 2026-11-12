// The desk follows the wall clock unless DESK_NOW is an ISO timestamp.
// The seeded books belong to Saturday 3 October 2026. A later wall clock
// falls outside that roster and the ledger stays shut until handover.

function deskNow() {
  const raw = process.env.DESK_NOW;
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('DESK_NOW must be an ISO timestamp');
  }
  return parsed;
}

module.exports = { deskNow };
