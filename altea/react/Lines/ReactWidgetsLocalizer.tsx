// altea replacement for Signum's ConfigureReactWidgets.tsx. Signum built a react-widgets
// DateLocalizer<string> on luxon (format = luxon token strings). altea drops luxon (→ Temporal), so
// the picker's display/parse layer is built on react-widgets' own Intl-based localizer instead, and
// the localizer's format type is `Intl.DateTimeFormatOptions`. Value handling (ISO string ⇄ Date,
// trimming) is done with Temporal in DateTimeLine — this module only wires the picker's localizer and
// maps altea/.NET format specifiers to Intl options.
import { DateLocalizer as IntlDateLocalizer, NumberLocalizer as IntlNumberLocalizer } from 'react-widgets-up/IntlLocalizer';
import type { DateLocalizer, NumberLocalizer } from 'react-widgets-up';

// react-widgets firstOfWeek is 0=Sunday..6=Saturday; the modern Intl weekInfo.firstDay is
// 1=Monday..7=Sunday, so `% 7` maps Sunday(7)→0 and leaves Mon..Sat as 1..6. Undefined ⇒ let the
// Intl localizer pick its default.
function computeFirstOfWeek(): number | undefined {
  try {
    const loc = new Intl.Locale(new Intl.DateTimeFormat().resolvedOptions().locale) as any;
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay != null)
      return info.firstDay % 7;
  } catch { /* older engines: fall through */ }
  return undefined;
}

export function getDateLocalizer(): DateLocalizer<Intl.DateTimeFormatOptions> {
  return new IntlDateLocalizer({ firstOfWeek: computeFirstOfWeek() }) as DateLocalizer<Intl.DateTimeFormatOptions>;
}

export function getNumberLocalizer(): NumberLocalizer<Intl.NumberFormatOptions> {
  return new IntlNumberLocalizer() as NumberLocalizer<Intl.NumberFormatOptions>;
}

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
    default:
      return dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" };
  }
}

// A placeholder hint derived from the Intl options (e.g. "dd/mm/yyyy"), replacing Signum's
// dateTimePlaceholder(luxonFormat).
export function dateTimePlaceholder(options: Intl.DateTimeFormatOptions): string {
  const sample = new Date(2000, 11, 31, 23, 59, 59); // 31 Dec 2000 23:59:59
  const map: { [k: string]: string } = { year: "yyyy", month: "mm", day: "dd", hour: "hh", minute: "mm", second: "ss" };
  return new Intl.DateTimeFormat(undefined, options).formatToParts(sample)
    .map(p => p.type == "literal" ? p.value : (map[p.type] ?? ""))
    .join("");
}

// Format an ISO date/datetime string for read-only display (Signum's toFormatWithFixes).
export function formatDateValue(iso: string, options: Intl.DateTimeFormatOptions): string {
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  return new Intl.DateTimeFormat(undefined, options).format(d);
}
