// Amounts in words. Kwacha always names kwacha and ngwee.
// Foreign amounts name one currency and leave out a zero minor unit.

const SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const UNITS = {
  ZMW: { one: 'kwacha', many: 'kwacha', minorOne: 'ngwee', minorMany: 'ngwee', alwaysMinor: true },
  EUR: { one: 'euro', many: 'euro', minorOne: 'cent', minorMany: 'cents', alwaysMinor: false },
  GBP: { one: 'pound', many: 'pounds', minorOne: 'penny', minorMany: 'pence', alwaysMinor: false },
  USD: { one: 'dollar', many: 'dollars', minorOne: 'cent', minorMany: 'cents', alwaysMinor: false },
  ZAR: { one: 'rand', many: 'rand', minorOne: 'cent', minorMany: 'cents', alwaysMinor: false },
};

function underThousand(value) {
  const n = Number(value);
  if (n < 20) return SMALL[n];
  if (n < 100) {
    const ten = Math.floor(n / 10);
    const rest = n % 10;
    return rest ? `${TENS[ten]}-${SMALL[rest]}` : TENS[ten];
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = `${SMALL[hundreds]} hundred`;
  return rest ? `${head} and ${underThousand(rest)}` : head;
}

function integerWords(value) {
  let n = BigInt(value);
  if (n < 0n) throw new TypeError('amounts in words are not negative');
  if (n === 0n) return 'zero';
  const scales = [
    [1000000000n, 'billion'],
    [1000000n, 'million'],
    [1000n, 'thousand'],
  ];
  const parts = [];
  for (const [scale, name] of scales) {
    if (n >= scale) {
      const count = n / scale;
      n %= scale;
      parts.push(`${underThousand(count)} ${name}`);
    }
  }
  if (n > 0n) {
    if (parts.length && n < 100n) parts.push('and');
    parts.push(underThousand(n));
  }
  return parts.join(' ');
}

function unitName(count, one, many) {
  return count === 1n ? one : many;
}

function amountInWords(minor, currency) {
  const spec = UNITS[currency];
  if (!spec) throw new TypeError(`no words for ${currency}`);
  const value = BigInt(minor);
  const major = value / 100n;
  const fraction = value % 100n;
  const majorWords = `${integerWords(major)} ${unitName(major, spec.one, spec.many)}`;
  if (!spec.alwaysMinor && fraction === 0n) return majorWords;
  const minorWords = `${integerWords(fraction)} ${unitName(fraction, spec.minorOne, spec.minorMany)}`;
  return `${majorWords} and ${minorWords}`;
}

module.exports = {
  integerWords,
  amountInWords,
};
