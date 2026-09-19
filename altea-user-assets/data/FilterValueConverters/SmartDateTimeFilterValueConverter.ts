import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import type { LocalizableMessage } from "@altea/altea/data/utils/localization";
import { QueryTokenDateMessage } from "@altea/altea/data/dynamicQueries";
import "@altea/altea/data/globals/dateTimeExtensions"; // weekStart()
import "@altea/altea/data/globals/arrayExtensions"; // notNull()
import { UserAssetQueryMessage } from "../UserAssets";
import {
    FilterValueResult, type FilterValueTarget, type IFilterValueConverter,
} from "./IFilterValueConverter";

// Port of Signum.UserAssets' SmartDateTimeFilterValueConverter — see port/UserAssets.md.
//
// A stored filter value may be RELATIVE, so a saved user query keeps meaning the same thing as time
// passes: "orders since the start of this month" stays that next month instead of freezing on a date.
//
// The spelling is a whole date-time, `yyyy/mm/dd hh:mm:ss`, where each part is one of
//   * the PATTERN itself (`yyyy`, `mm`, `dd`, `hh`, `mm`, `ss`) — "whatever it is now",
//   * `+n` / `-n` — now's value shifted,
//   * a literal number,
// and the DAY part additionally accepts `max` (last day of that month) or a weekday
// (`sun|mon|tue|wed|thu|fri|sat`) with an optional `+n` / `-n`.
//
// The parts are mixed with `Clock.now` INDEPENDENTLY and then carried (60 seconds become a minute, a day
// past the end of the month the next month), which is what makes `-1/mm/dd 00:00:00` mean "this day and
// month, a year ago" rather than "365 days ago".
//
// DIVERGENCE — a string that does not have the `a/b/c d:e:f` SHAPE is "not mine" here, where Signum calls
// it an error ("Invalid Format: yyyy/mm/dd hh:mm:ss"). Signum can afford that because it writes EVERY date
// filter value through this converter, so a stored date is always in the shape; altea stores the plain ISO
// value unless the user asks for an expression, and an error would reject every one of them.

const partRegex = /^((\+\d+)|(-\d+)|(\d+))$/;
const dayComplexRegex = /^(?<text>sun|mon|tue|wed|thu|fri|sat|max)(?<inc>[+-]\d+)?$/i;
const spanRegex = /^(?<year>.+)\/(?<month>.+)\/(?<day>.+) (?<hour>.+):(?<minute>.+):(?<second>.+)$/i;

/** The whole grammar, spelled out — the hint the expression editor shows. */
export const smartDateTimeFormat: string = "yyyy/mm/dd hh:mm:ss";

/** Monday = 1 … Sunday = 7, matching `Temporal.PlainDate.dayOfWeek` (and altea's `DayOfWeek`). */
const weekDays: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

/** One position of the span: its pattern, its human name, and the range a LITERAL there may take. */
interface PartSpec {
    readonly name: LocalizableMessage;
    readonly pattern: string;
    readonly min: number;
    readonly max: number;
    readonly isDay?: boolean;
}

const parts = {
    year: { name: QueryTokenDateMessage.Year, pattern: "yyyy", min: 0, max: Number.MAX_SAFE_INTEGER },
    month: { name: QueryTokenDateMessage.Month, pattern: "mm", min: 1, max: 12 },
    day: { name: QueryTokenDateMessage.Day, pattern: "dd", min: 1, max: 31, isDay: true },
    hour: { name: QueryTokenDateMessage.Hour, pattern: "hh", min: 0, max: 23 },
    minute: { name: QueryTokenDateMessage.Minute, pattern: "mm", min: 0, max: 59 },
    second: { name: QueryTokenDateMessage.Second, pattern: "ss", min: 0, max: 59 },
} satisfies Record<string, PartSpec>;

/**
 * A parsed smart date-time: the six parts, still as the strings that were written.
 *
 * Signum's `SmartDateTimeSpan`. Kept as a class with the same members because it is the unit both
 * directions work in — `toPlainDateTime` resolves it against a clock, `subtract` builds one from a date.
 */
export class SmartDateTimeSpan {
    year: string = parts.year.pattern;
    month: string = parts.month.pattern;
    day: string = parts.day.pattern;
    hour: string = parts.hour.pattern;
    minute: string = parts.minute.pattern;
    second: string = parts.second.pattern;

    /** `null` when the string is not meant to be a smart date at all; an error when it is but is malformed. */
    static tryParse(str: string | null | undefined): FilterValueResult<SmartDateTimeSpan> | null {
        if (str == null || str === "")
            return null;

        const match = spanRegex.exec(str);
        if (match == null)
            return null;

        const g = match.groups!;
        const error =
            assertPart(g["year"]!, parts.year) ??
            assertPart(g["month"]!, parts.month) ??
            assertPart(g["day"]!, parts.day) ??
            assertPart(g["hour"]!, parts.hour) ??
            assertPart(g["minute"]!, parts.minute) ??
            assertPart(g["second"]!, parts.second);

        if (error != null)
            return FilterValueResult.error(error);

        const span = new SmartDateTimeSpan();
        span.year = g["year"]!;
        span.month = g["month"]!;
        span.day = g["day"]!;
        span.hour = g["hour"]!;
        span.minute = g["minute"]!;
        span.second = g["second"]!;
        return FilterValueResult.success(span);
    }

    /** Resolve against a clock (the test seam is the argument; production passes `Clock.now`). */
    toPlainDateTime(now: Temporal.PlainDateTime = Clock.now): Temporal.PlainDateTime {
        let year = mix(now.year, this.year, parts.year.pattern);
        let month = mix(now.month, this.month, parts.month.pattern);
        let day: number;

        const m = dayComplexRegex.exec(this.day);
        if (m != null) {
            const text = m.groups!["text"]!.toLowerCase();
            const inc = m.groups!["inc"];
            ({ year, month } = normalizeMonth(year, month)); // the right month, before asking its length
            if (text === "max") {
                day = daysInMonth(year, month);
            } else {
                // Signum walks from the CULTURE's week start to the named weekday; altea's `weekStart` is
                // Monday-based (see data/globals/dateTimeExtensions), so `sun` is the END of the week here
                // and the START of it under en-US. The same divergence the WeekStart query token has.
                // `constrain` rather than throw: `now.day` may not exist in the resolved month (the 31st
                // of a 30-day one), where Signum's `new DateTime(...)` raises.
                let date = Temporal.PlainDate
                    .from({ year, month, day: now.day }, { overflow: "constrain" })
                    .weekStart()
                    .add({ days: weekDays[text]! - 1 });
                if (inc != null && inc !== "")
                    date = date.add({ days: parseInt(inc, 10) });
                year = date.year;
                month = date.month;
                day = date.day;
            }
        } else {
            day = mix(now.day, this.day, parts.day.pattern);
        }

        let hour = mix(now.hour, this.hour, parts.hour.pattern);
        let minute = mix(now.minute, this.minute, parts.minute.pattern);
        let second = mix(now.second, this.second, parts.second.pattern);

        // Carry each overflow upwards. Every part was mixed independently, so `hh:mm:-30` on the minute 0
        // is a real input and has to borrow from the minute, the hour and possibly the day.
        [minute, second] = carry(minute, second, 60);
        [hour, minute] = carry(hour, minute, 60);
        [day, hour] = carry(day, hour, 24);

        ({ year, month, day } = normalizeDate(year, month, day));

        return new Temporal.PlainDateTime(year, month, day, hour, minute, second);
    }

    /**
     * The inverse: how `date` reads RELATIVE to `now`.
     *
     * A part that equals now's becomes its pattern and a part one off becomes `+1` / `-1`; anything else
     * stays a literal. A date landing on the last day of its month is written `max`.
     */
    static subtract(date: Temporal.PlainDateTime, now: Temporal.PlainDateTime = Clock.now): SmartDateTimeSpan {
        const span = new SmartDateTimeSpan();
        span.year = difference(now.year - date.year, parts.year.pattern) ?? pad(date.year, 4);
        span.month = difference(now.month - date.month, parts.month.pattern) ?? pad(date.month, 2);
        span.day = date.day === daysInMonth(date.year, date.month)
            ? "max"
            : (difference(now.day - date.day, parts.day.pattern) ?? pad(date.day, 2));

        if (date.hour === 0 && date.minute === 0 && date.second === 0) {
            span.hour = span.minute = span.second = "00";
        } else {
            span.hour = difference(now.hour - date.hour, parts.hour.pattern) ?? pad(date.hour, 2);
            span.minute = difference(now.minute - date.minute, parts.minute.pattern) ?? pad(date.minute, 2);
            span.second = difference(now.second - date.second, parts.second.pattern) ?? pad(date.second, 2);
        }
        return span;
    }

    /** The same date with every part written out — a smart date that is not relative to anything. */
    static simple(date: Temporal.PlainDateTime): SmartDateTimeSpan {
        const span = new SmartDateTimeSpan();
        span.year = pad(date.year, 4);
        span.month = pad(date.month, 2);
        span.day = pad(date.day, 2);
        span.hour = pad(date.hour, 2);
        span.minute = pad(date.minute, 2);
        span.second = pad(date.second, 2);
        return span;
    }

    toString(): string {
        return `${this.year}/${this.month}/${this.day} ${this.hour}:${this.minute}:${this.second}`;
    }
}

/** Does this stored string want to be read as a smart date at all? (Shape only — it may still be invalid.) */
export function isSmartDateTimeExpression(str: string | null | undefined): boolean {
    return str != null && spanRegex.test(str);
}

/**
 * A date (a Temporal, or the ISO string an altea filter value holds) written as a smart date relative to
 * `now` — Signum's `TryGetExpression`.
 *
 * NOT wired into the registry's toString direction, which is where Signum puts it. Signum has no way for a
 * user to say whether a saved date filter is meant absolutely or relatively, so it guesses on EVERY save:
 * a filter for the 19th saved on the 19th is stored `yyyy/mm/dd 00:00:00` and means the 19th of next month
 * next month. altea's filter editor has an explicit value↔expression toggle (FilterBuilderEmbedded), so
 * the choice is the user's — and `stringifyFilterValue` is reused by callers that are not stored filters
 * at all (altea-machine-learning codifies a predictor column's KEYS with it), where a relative spelling
 * would be simply wrong. This is what the toggle seeds the expression box with.
 */
export function smartDateTimeExpression(
    value: Temporal.PlainDate | Temporal.PlainDateTime | string,
    now: Temporal.PlainDateTime = Clock.now,
): string {
    return SmartDateTimeSpan.subtract(asPlainDateTime(value), now).toString();
}

function asPlainDateTime(value: Temporal.PlainDate | Temporal.PlainDateTime | string): Temporal.PlainDateTime {
    if (typeof value === "string")
        return value.includes("T") ? Temporal.PlainDateTime.from(value) : Temporal.PlainDate.from(value).toPlainDateTime();
    return value instanceof Temporal.PlainDate ? value.toPlainDateTime() : value;
}

/**
 * `null` unless the written part is unusable, in which case the (localized) reason.
 *
 * Signum opens with an "{0} has no value" case; every group of the grammar is `.+`, so a part that matched
 * at all is non-empty and that branch cannot be reached. Dropped rather than carried with a message key
 * nothing would ever show.
 */
function assertPart(result: string, spec: PartSpec): string | null {
    if (result === spec.pattern)
        return null;

    if (partRegex.test(result)) {
        if (result.includes("+") || result.includes("-"))
            return null;

        const val = parseInt(result, 10);
        if (spec.min <= val && val <= spec.max)
            return null;

        return UserAssetQueryMessage._0MustBeBetween1And2.niceToString(spec.name.niceToString(), spec.min, spec.max);
    }

    if (spec.isDay === true && dayComplexRegex.test(result))
        return null;

    const options = [
        spec.pattern, "const", "+inc", "-dec",
        spec.isDay === true ? "(max|sun|mon|tue|wed|thu|fri|sat)(+inc|-dec)?" : null,
    ].notNull().join(" or ");

    return UserAssetQueryMessage._0IsNotAValid1Try2Instead.niceToString(result, spec.name.niceToString(), options);
}

/** The written part against now's value for that part. */
function mix(current: number, rule: string, pattern: string): number {
    if (rule.toLowerCase() === pattern.toLowerCase())
        return current;
    if (rule.startsWith("+"))
        return current + parseInt(rule.substring(1), 10);
    if (rule.startsWith("-"))
        return current - parseInt(rule.substring(1), 10);
    return parseInt(rule, 10);
}

/**
 * Move `value`'s whole multiples of `size` into `higher`, leaving `value` in `[0, size)`.
 *
 * Signum writes `higher += value.DivMod(size, out value)`, and its `DivMod` is FLOOR division except on an
 * exact negative multiple, where it answers `(-2, 60)` for `-60 DivMod 60` — a remainder equal to the
 * divisor, which then reaches `new DateTime(…, 60)` and throws. Plain floor division here.
 */
function carry(higher: number, value: number, size: number): [number, number] {
    const q = Math.floor(value / size);
    return [higher + q, value - q * size];
}

/** Bring `month` into 1..12, carrying whole years (Signum's `MonthDivMod`). */
function normalizeMonth(year: number, month: number): { year: number; month: number } {
    const q = Math.floor((month - 1) / 12);
    return { year: year + q, month: month - q * 12 };
}

/** Bring `month` into 1..12 and `day` into that month, carrying whole months (Signum's `DateDivMod`). */
function normalizeDate(year: number, month: number, day: number): { year: number; month: number; day: number } {
    ({ year, month } = normalizeMonth(year, month)); // the right month first — its length is what bounds the day

    let dim: number;
    while (day > (dim = daysInMonth(year, month))) {
        day -= dim;
        ({ year, month } = normalizeMonth(year, month + 1));
    }

    while (day <= 0) {
        ({ year, month } = normalizeMonth(year, month - 1));
        day += daysInMonth(year, month);
    }

    return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
    return Temporal.PlainDate.from({ year, month, day: 1 }).daysInMonth;
}

/** How a one-part difference is written: none at all → the pattern, one off → `+1` / `-1`, else a literal. */
function difference(diff: number, pattern: string): string | null {
    if (diff === 0) return pattern;
    if (diff === +1) return "-1";
    if (diff === -1) return "+1";
    return null;
}

function pad(value: number, length: number): string {
    return String(value).padStart(length, "0");
}

/**
 * The registry entry. `tryGetExpression` deliberately declines — see {@link smartDateTimeExpression}.
 *
 * The parsed value is an ISO STRING rather than a Temporal, because that is what an altea filter value for
 * a date IS on both tiers (Finder.parseFilterValues); the server coerces it to the column's own Temporal
 * with `Temporal.PlainDate(Time).from`. A `PlainDate` token gets the date half, so a date-only editor is
 * not handed a timestamp.
 */
export const SmartDateTimeFilterValueConverter: IFilterValueConverter = {

    tryGetExpression(): FilterValueResult<string | null> | null {
        return null;
    },

    tryParseExpression(expression: string, target: FilterValueTarget): FilterValueResult<unknown> | null {
        if (!isDate(target))
            return null;

        const res = SmartDateTimeSpan.tryParse(expression);
        if (res == null || !res.ok)
            return res;

        const dt = res.value.toPlainDateTime();
        return FilterValueResult.success(target.typeName === "PlainDate" ? dt.toPlainDate().toString() : dt.toString());
    },

    isValidExpression(expression: string, target: FilterValueTarget): FilterValueResult<string> | null {
        if (!isDate(target))
            return null;

        const res = SmartDateTimeSpan.tryParse(expression);
        if (res == null)
            return null;
        return res.ok ? FilterValueResult.success(res.value.toString()) : res;
    },
};

/** Signum's `IsDate(targetType)`: both `PlainDate` and `PlainDateTime` are FilterType "DateTime". */
function isDate(target: FilterValueTarget): boolean {
    return target.filterType === "DateTime";
}
