// Exact money. Amounts are bigint minor units (1/100 of the major unit).
// Decimal strings are accepted. JavaScript numbers are rejected so floats
// cannot enter the ledger, the variance check, or the core-bank comparison.

function toMinor(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new TypeError('money amounts cannot be negative');
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new TypeError('money amounts must be decimal strings or bigint minor units');
  }
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    throw new TypeError(`invalid money amount: ${value}`);
  }
  const whole = BigInt(match[1]);
  const frac = (match[2] || '').padEnd(2, '0');
  return whole * 100n + BigInt(frac);
}

function toDecimalString(minor) {
  if (typeof minor !== 'bigint') {
    throw new TypeError('minor units must be bigint');
  }
  if (minor < 0n) {
    throw new TypeError('money amounts cannot be negative');
  }
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${frac}`;
}

function formatMoney(minor, symbol, { signed = false } = {}) {
  const decimal = toDecimalString(minor);
  const [whole, frac] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${symbol}${grouped}.${frac}`;
  if (signed) {
    return `+ ${body}`;
  }
  return body;
}

function mapsEqual(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? null) !== (right[key] ?? null)) {
      return false;
    }
    if (typeof left[key] !== 'bigint' || typeof right[key] !== 'bigint') {
      return false;
    }
  }
  return true;
}

module.exports = {
  toMinor,
  toDecimalString,
  formatMoney,
  mapsEqual,
};
