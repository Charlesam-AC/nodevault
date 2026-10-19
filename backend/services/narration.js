const { toDecimalString } = require('./money');
const { amountInWords } = require('./words');

const FOREIGN = ['EUR', 'GBP', 'USD', 'ZAR'];

function currenciesFor(bookClass) {
  return bookClass === 'KWACHA_TREASURY' ? ['ZMW'] : FOREIGN.slice();
}

function grouped(minor) {
  const [whole, frac] = toDecimalString(BigInt(minor)).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

function figureText(currency, minor, options = {}) {
  const body = grouped(minor);
  if (currency === 'ZMW') return options.kwachaCode ? `ZMW ${body}` : body;
  return `${currency} ${body}`;
}

function figuresFromMinors(bookClass, minors, options = {}) {
  return currenciesFor(bookClass).map((currency) => {
    const minor = BigInt(minors[currency] || 0);
    return {
      currency,
      minor: minor.toString(),
      figure: figureText(currency, minor, options),
      words: amountInWords(minor, currency),
    };
  });
}

function nameList(people) {
  return people.map((person) => `${person.fullLegalName}, ${person.employeeId}`).join(' and ');
}

function formatStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lusaka',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('day')}/${pick('month')}/${pick('year')} ${pick('hour')}:${pick('minute')}`;
}

function quotedFigures(figures) {
  return figures.map((item) => `"${item.figure}" "(${item.words})"`).join(', ');
}

function takeoverSentence({ figures, incoming, outgoing, at }) {
  const by = nameList(incoming);
  const from = nameList(outgoing);
  const when = formatStamp(at);
  return `Takeover cash check was done and found to be correct as ${quotedFigures(figures)} by "${by}" from "${from}" on "${when}".  All pages checks correctly and intact.  "${by}"`;
}

function differenceClause(differences) {
  const groups = [];
  for (const direction of ['short', 'over']) {
    const items = differences.filter((item) => item.direction === direction);
    if (!items.length) continue;
    groups.push(`${direction} by ${quotedFigures(items)}`);
  }
  return groups.join(' and ');
}

function surpriseSentence({ figures, differences, checker, at }) {
  const who = `${checker.fullLegalName}, ${checker.employeeId}`;
  const when = formatStamp(at);
  const finding = differences && differences.length
    ? `found to be ${differenceClause(differences)}`
    : `found to be correct as ${quotedFigures(figures)}`;
  return `Surprise cash check was done and ${finding} by "${who}" on "${when}". All pages checks correctly and intact. "${who}".`;
}

function compareFigures(systemFigures, countedFigures, options = {}) {
  const differences = [];
  systemFigures.forEach((system, index) => {
    const counted = countedFigures[index];
    const systemMinor = BigInt(system.minor);
    const countedMinor = BigInt(counted.minor);
    if (systemMinor === countedMinor) return;
    const gap = systemMinor > countedMinor ? systemMinor - countedMinor : countedMinor - systemMinor;
    differences.push({
      currency: system.currency,
      direction: countedMinor < systemMinor ? 'short' : 'over',
      minor: gap.toString(),
      figure: figureText(system.currency, gap, options),
      words: amountInWords(gap, system.currency),
    });
  });
  return differences;
}

module.exports = {
  currenciesFor,
  figureText,
  figuresFromMinors,
  nameList,
  formatStamp,
  takeoverSentence,
  surpriseSentence,
  compareFigures,
};
