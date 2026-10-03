const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function calendarOptions(overrides = {}) {
  const holidays = Object.prototype.hasOwnProperty.call(overrides, 'holidays')
    ? overrides.holidays
    : String(process.env.BANK_HOLIDAYS || '')
      .split(',')
      .map((day) => day.trim())
      .filter(Boolean);
  return {
    timeZone: overrides.timeZone || process.env.BUSINESS_TIMEZONE || 'Africa/Lusaka',
    dayStart: overrides.dayStart || process.env.BUSINESS_DAY_START || '08:00',
    holidays,
  };
}

function parseIso(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new TypeError('date must be YYYY-MM-DD');
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function isoFromUtc(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(isoDate, days) {
  const { year, month, day } = parseIso(isoDate);
  return isoFromUtc(year, month, day + days);
}

function diffDays(later, earlier) {
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  return Math.round((a - b) / 86400000);
}

function addMonths(isoDate, months) {
  const { year, month, day } = parseIso(isoDate);
  const index = month - 1 + months;
  const nextYear = year + Math.floor(index / 12);
  const nextMonth = ((index % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  return isoFromUtc(nextYear, nextMonth + 1, Math.min(day, lastDay));
}

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
  };
}

function startMinutes(dayStart) {
  const match = /^(\d{2}):(\d{2})$/.exec(dayStart);
  if (!match) throw new TypeError('BUSINESS_DAY_START must be HH:MM');
  return Number(match[1]) * 60 + Number(match[2]);
}

function isBusinessDay(isoDate, holidays) {
  const { year, month, day } = parseIso(isoDate);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !(holidays || []).includes(isoDate);
}

function previousBusinessDay(isoDate, holidays) {
  let cursor = addDays(isoDate, -1);
  for (let i = 0; i < 370; i += 1) {
    if (isBusinessDay(cursor, holidays)) return cursor;
    cursor = addDays(cursor, -1);
  }
  throw new Error('no previous business day');
}

function nextBusinessDay(isoDate, holidays) {
  let cursor = addDays(isoDate, 1);
  for (let i = 0; i < 370; i += 1) {
    if (isBusinessDay(cursor, holidays)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new Error('no next business day');
}

// The date whose morning has started, or null when it is still the previous session.
function businessMorning(now, overrides = {}) {
  const options = calendarOptions(overrides);
  const zoned = zonedParts(now, options.timeZone);
  if (!isBusinessDay(zoned.isoDate, options.holidays)) return null;
  if (zoned.minutes < startMinutes(options.dayStart)) return null;
  return zoned.isoDate;
}

// The next date the desk will treat as a business morning, including later today.
function upcomingBusinessDate(now, overrides = {}) {
  const options = calendarOptions(overrides);
  const opened = businessMorning(now, options);
  if (opened) return opened;
  const zoned = zonedParts(now, options.timeZone);
  if (isBusinessDay(zoned.isoDate, options.holidays)) return zoned.isoDate;
  return nextBusinessDay(zoned.isoDate, options.holidays);
}

function periodContaining(schedule, isoDate) {
  const anchor = schedule.anchorDate || schedule.anchor_date;
  const cadence = schedule.cadence;
  if (isoDate < anchor) return null;
  if (cadence === 'MONTHLY') {
    let start = anchor;
    for (let step = 0; step < 600; step += 1) {
      const next = addMonths(anchor, step + 1);
      const end = addDays(next, -1);
      if (isoDate >= start && isoDate <= end) {
        return { periodStart: start, periodEnd: end };
      }
      start = next;
    }
    throw new Error('monthly period not found');
  }
  const length = cadence === 'WEEKLY' ? 7
    : cadence === 'FORTNIGHTLY' ? 14
      : Number(schedule.customDays || schedule.custom_days);
  if (!Number.isInteger(length) || length < 1) {
    throw new TypeError('rotation length is not configured');
  }
  const index = Math.floor(diffDays(isoDate, anchor) / length);
  const periodStart = addDays(anchor, index * length);
  const periodEnd = addDays(periodStart, length - 1);
  return { periodStart, periodEnd };
}

module.exports = {
  calendarOptions,
  addDays,
  diffDays,
  isBusinessDay,
  previousBusinessDay,
  nextBusinessDay,
  businessMorning,
  upcomingBusinessDate,
  periodContaining,
  zonedParts,
};
