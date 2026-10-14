import { Temporal } from "../../data/basics";
import { Clock } from "../../data/utils/clock";

// Map an altea/.NET date format specifier + column type to Intl.DateTimeFormatOptions (Signum's
// toLuxonFormat, retargeted from luxon tokens to Intl options). Standard single-letter .NET
// specifiers are covered; custom patterns (e.g. "yyyy-MM-dd") fall back to the type default.
// TODO(port): faithful custom-pattern → Intl mapping if a query needs it.
export function toDateFormatOptions(format: string | undefined, type: "PlainDate" | "PlainDateTime"): Intl.DateTimeFormatOptions {
  const dateOnly = type == "PlainDate";
  switch (format) {
    case "d": return { dateStyle: "short" };
    case "D": return { dateStyle: "long" };
    case "f": return { dateStyle: "long", timeStyle: "short" };
    case "F": return { dateStyle: "long", timeStyle: "medium" };
    case "g": return { dateStyle: "short", timeStyle: "short" };
    case "G": return { dateStyle: "short", timeStyle: "medium" };
    case "t": return { timeStyle: "short" };
    case "T": return { timeStyle: "medium" };
    case "M": case "m": return { month: "long", day: "numeric" };
    case "Y": case "y": return { year: "numeric", month: "long" };
    // The two altea-only specifiers, for the DateTimePrecision cases .NET has no standard letter for
    // (see reflection's dateTimePrecisionFormat): a date to the HOUR and a date to the MILLISECOND.
    // Signum builds a culture pattern for each; here the parts are named and Intl supplies the culture.
    // Component style, not dateStyle/timeStyle — Intl forbids mixing the two, and a lone `hour` or a
    // `fractionalSecondDigits` is exactly what has to be said.
    case "dH": return { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" };
    case "Gf": return { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 };
    default:
      return dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" };
  }
}

// A placeholder hint derived from the Intl options (e.g. "dd/mm/yyyy"), replacing Signum's
// dateTimePlaceholder(luxonFormat).
export function dateTimePlaceholder(options: Intl.DateTimeFormatOptions): string {
  const sample = new Date(2000, 11, 31, 23, 59, 59); // 31 Dec 2000 23:59:59
  const map: { [k: string]: string } = { year: "yyyy", month: "mm", day: "dd", hour: "hh", minute: "mm", second: "ss", fractionalSecond: "fff" };
  return new Intl.DateTimeFormat(undefined, options).formatToParts(sample)
    .map(p => p.type == "literal" ? p.value : (map[p.type] ?? ""))
    .join("");
}

/** A date field's value: a calendar day, or a datetime in the Clock's frame. */
export type DateValue = Temporal.PlainDate | Temporal.PlainDateTime;

// Format a date value for read-only display (Signum's toFormatWithFixes).
export function formatDateValue(value: DateValue, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, options).format(dateValueToDate(value));
}

// A stored value → the JS Date Intl formats, at the wall time the user should SEE in the
// browser's zone. A PlainDate is a calendar day and never shifts; a PlainDateTime is in the Clock's frame, so
// under a UTC clock it moves to the viewer's zone (Clock.toUserInterface).
export function dateValueToDate(value: DateValue): Date {
  if (value instanceof Temporal.PlainDate)
    return new Date(value.year, value.month - 1, value.day);
  const ui = Clock.toUserInterface(value);
  return new Date(ui.year, ui.month - 1, ui.day, ui.hour, ui.minute, ui.second, ui.millisecond);
}

// The inverse: the JS Date the user picked → the value to STORE.
export function dateToDateValue(date: Date, dateOnly: true): Temporal.PlainDate;
export function dateToDateValue(date: Date, dateOnly: boolean, withTime?: boolean): DateValue;
export function dateToDateValue(date: Date, dateOnly: boolean, withTime = true): DateValue {
  const day = Temporal.PlainDate.from({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
  if (dateOnly)
    return day;
  return Clock.fromUserInterface(withTime
    ? day.toPlainDateTime({ hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() })
    : day.toPlainDateTime());
}
// A date value converted to a token's type and trimmed to the precision its format shows (Signum's
// trimDateToFormat): a PlainDate token takes the day, a month/year-only format the first of the month.
// TODO(port): richer custom-format precision trimming if needed.
export function trimDateToFormat(value: DateValue, type: "PlainDate" | "PlainDateTime", format: string | undefined): DateValue {
  const options = toDateFormatOptions(format, type);
  const monthOnly = options.year != null && options.month != null && options.day == null && options.dateStyle == null;

  let day = value instanceof Temporal.PlainDate ? value : value.toPlainDate();
  if (monthOnly)
    day = day.with({ day: 1 });

  if (type == "PlainDate")
    return day;

  return monthOnly || value instanceof Temporal.PlainDate ? day.toPlainDateTime() : value;
}

export interface WeekInfo {
  /** 1 = Monday … 7 = Sunday, Temporal's `dayOfWeek`. */
  firstDay: number;
  weekend: number[];
}

/** The culture's first day of the week and weekend, from `Intl.Locale#getWeekInfo` where the engine has it. */
export function weekInfo(locale?: string): WeekInfo {
  try {
    const loc = new Intl.Locale(locale ?? new Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number, weekend: number[] }, weekInfo?: { firstDay: number, weekend: number[] }
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay != null)
      return { firstDay: info.firstDay, weekend: info.weekend ?? [6, 7] };
    const sundayFirst = ["US", "CA", "MX", "BR", "JP", "KR", "IL", "PH", "IN"];
    return { firstDay: sundayFirst.includes(loc.maximize().region ?? "") ? 7 : 1, weekend: [6, 7] };
  } catch {
    return { firstDay: 1, weekend: [6, 7] };
  }
}

/**
 * What the user typed → a value, read in the order the culture writes dates (`31/12/2026`, `12/31/2026`,
 * `2026-12-31`), with any separator. Two-digit years land in 1950–2049; a missing year is this year. Time
 * fields follow the date; `pm` is honoured. Null when it is not a real date.
 */
export function parseDateText(text: string, options: Intl.DateTimeFormatOptions, type: "PlainDate" | "PlainDateTime", today: Temporal.PlainDate): DateValue | null {
  const numbers = text.match(/\d+/g)?.map(Number);
  if (numbers == null || numbers.length < 2)
    return null;

  const order = text.trim().match(/^\d{4}/) ? ["year", "month", "day"] : dateFieldOrder(options);
  const fields: Record<string, number> = {};
  order.forEach((f, i) => { if (numbers[i] != null) fields[f] = numbers[i]; });
  const dateCount = Math.min(order.length, numbers.length);

  let year = fields.year ?? today.year;
  if (fields.year != null && String(numbers[order.indexOf("year")]).length <= 2)
    year = year < 50 ? 2000 + year : 1900 + year;

  let date: Temporal.PlainDate;
  try {
    date = Temporal.PlainDate.from({ year, month: fields.month ?? 1, day: fields.day ?? 1 }, { overflow: "reject" });
  } catch {
    return null;
  }

  if (type === "PlainDate")
    return date;

  const [hour = 0, minute = 0, second = 0] = numbers.slice(dateCount);
  let h = hour;
  if (/p\.?\s*m\.?/i.test(text) && h < 12) h += 12;
  if (/a\.?\s*m\.?/i.test(text) && h === 12) h = 0;
  try {
    return Clock.fromUserInterface(date.toPlainDateTime(Temporal.PlainTime.from({ hour: h, minute, second }, { overflow: "reject" })));
  } catch {
    return null;
  }
}

function dateFieldOrder(options: Intl.DateTimeFormatOptions): string[] {
  const dateOptions: Intl.DateTimeFormatOptions = options.dateStyle ? { dateStyle: "short" } : { year: "numeric", month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat(undefined, dateOptions).formatToParts(new Date(2000, 11, 31))
    .map(p => p.type)
    .filter(t => t === "year" || t === "month" || t === "day");
}
