const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { deskNow } = require('../services/clock');

describe('desk clock', () => {
  const previous = process.env.DESK_NOW;

  beforeEach(() => {
    delete process.env.DESK_NOW;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.DESK_NOW;
    else process.env.DESK_NOW = previous;
  });

  it('uses the wall clock when DESK_NOW is empty', () => {
    const before = Date.now();
    const now = deskNow().getTime();
    const after = Date.now();
    assert.ok(now >= before && now <= after);
  });

  it('uses the seeded Saturday morning when DESK_NOW is set', () => {
    process.env.DESK_NOW = '2026-10-03T10:00:00+02:00';
    assert.equal(deskNow().toISOString(), '2026-10-03T08:00:00.000Z');
  });

  it('refuses a clock that is not a timestamp', () => {
    process.env.DESK_NOW = 'Saturday';
    assert.throws(() => deskNow(), /ISO timestamp/);
  });
});
