const { addDays } = require('./calendar');

// Public Holidays Act, Cap. 272, as amended by Act No. 23 of 1987, plus days
// declared under section 3 and still observed every year.
// Section 2(2): when a Schedule day falls on a Sunday, the following Monday is
// a public holiday. The same observance is applied to the annual declared days.
// A Saturday is not moved. N.A.B. 76 of 2026, which would delete s.2(2), was
// not enacted (withdrawn at second reading on 12 May 2026).
// Kenneth Kaunda Day is 28 April (S.I. No. 72 of 2021), not the last Monday of April.

const FIXED = [
  { name: "New Year's Day", month: 1, day: 1, authority: 'Public Holidays Act, Cap. 272, Schedule' },
  { name: "International Women's Day", month: 3, day: 8, authority: 'Annual public-holiday notice; 8 March' },
  { name: 'Youth Day', month: 3, day: 12, authority: 'Public Holidays Act, Cap. 272, Schedule' },
  { name: 'Kenneth Kaunda Day', month: 4, day: 28, authority: 'Statutory Instrument No. 72 of 2021' },
  { name: 'Labour Day', month: 5, day: 1, authority: 'Public Holidays Act, Cap. 272, Schedule' },
  { name: 'Africa Freedom Day', month: 5, day: 25, authority: 'Public Holidays Act, Cap. 272, Schedule (African Freedom Day)' },
  { name: 'National Day of Prayer, Fasting, Repentance and Reconciliation', month: 10, day: 18, authority: 'Statutory Instrument No. 78 of 2015' },
  { name: 'Independence Day', month: 10, day: 24, authority: 'Public Holidays Act, Cap. 272, Schedule' },
  { name: 'Christmas Day', month: 12, day: 25, authority: 'Public Holidays Act, Cap. 272, Schedule' },
];

function iso(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function weekday(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function firstWeekday(year, month, dow) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((dow - first + 7) % 7);
  return iso(year, month, day);
}

// Anonymous Gregorian computus. Month is 3 or 4.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

function observe(entry) {
  const rows = [entry];
  if (weekday(entry.date) === 0) {
    rows.push({
      date: addDays(entry.date, 1),
      name: entry.name,
      observance: 'SUNDAY_FOLLOWING',
      statutoryDate: entry.date,
      authority: 'Public Holidays Act s.2(2): Sunday holiday observed the following Monday',
    });
  }
  return rows;
}

function zambiaHolidays(year) {
  if (!Number.isInteger(year) || year < 1964 || year > 2100) {
    throw new TypeError('holiday year is out of range');
  }
  const easter = easterSunday(year);
  const heroes = firstWeekday(year, 7, 1);
  const farmers = firstWeekday(year, 8, 1);
  const named = [
    ...FIXED.map((rule) => ({
      date: iso(year, rule.month, rule.day),
      name: rule.name,
      observance: 'STATUTORY',
      authority: rule.authority,
    })),
    {
      date: addDays(easter, -2),
      name: 'Good Friday',
      observance: 'STATUTORY',
      authority: 'Public Holidays Act, Cap. 272, Schedule',
    },
    {
      date: addDays(easter, -1),
      name: 'Holy Saturday',
      observance: 'STATUTORY',
      authority: 'Public Holidays Act, Cap. 272, Schedule',
    },
    {
      date: addDays(easter, 1),
      name: 'Easter Monday',
      observance: 'STATUTORY',
      authority: 'Annual gazette notice. The 1996 Schedule stops at Holy Saturday.',
    },
    {
      date: heroes,
      name: 'Heroes Day',
      observance: 'STATUTORY',
      authority: 'Public Holidays Act, Cap. 272, Schedule: first Monday in July',
    },
    {
      date: addDays(heroes, 1),
      name: 'Unity Day',
      observance: 'STATUTORY',
      authority: 'Public Holidays Act, Cap. 272, Schedule: Tuesday following Heroes Day',
    },
    {
      date: farmers,
      name: "Farmers' Day",
      observance: 'STATUTORY',
      authority: 'Public Holidays Act, Cap. 272, Schedule: first Monday in August',
    },
  ];
  const rows = named.flatMap(observe);
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return rows;
}

function holidayDates(year) {
  return [...new Set(zambiaHolidays(year).map((row) => row.date))];
}

module.exports = {
  easterSunday,
  zambiaHolidays,
  holidayDates,
  weekday,
};
