import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, part, backReference, uniqueIndex, quoted, primaryKey } from "@altea/altea/data/decorators";
import { stringLengthValidator, validate } from "@altea/altea/data/validators";
import { Temporal, type int } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// A named set of dates that a weekday schedule rule consults, so a task can run "every weekday BUT
// holidays" (or only on them).
//
// The cache behind `isHoliday` is a per-INSTANCE Map built on first use: the entity is a plain field bag,
// so it is rebuilt whenever the instance is.
//
// Port of Signum.Scheduler's HolidayCalendarEntity.cs — see docs/port/Scheduler.md.

@part
export class HolidayCalendarEntity_Holiday extends Entity {
    @backReference calendar: Lite<HolidayCalendarEntity>;
    // No `@rowOrder`: this table has no Order column, so its
    // table has no Order column. The rows come back in primary-key order, which for a list saved in
    // order is that order — a calendar of dates has no meaningful sequence to preserve anyway.

    date: Temporal.PlainDate;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null = null;

    toString(): string {
        return `${this.date?.toString() ?? ""} ${this.name ?? ""}`.trim();
    }
}

@reflect
@entity("Shared", "Master")
// A FILTERED unique index, so at
// most one calendar is the default while any number are not.
@uniqueIndex<HolidayCalendarEntity>(c => c.isDefault, c => c.isDefault)
@primaryKey("uuid")
export class HolidayCalendarEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    fromYear: int | null = null;
    toYear: int | null = null;
    countryCode: string | null = null;
    subDivisionCode: string | null = null;

    /** The calendar a new ScheduleRuleWeekDays picks by default (at most one — see the class index). */
    isDefault: boolean = false;

    @validate<HolidayCalendarEntity>(c => repeatedDates(c))
    holidays: HolidayCalendarEntity_Holiday[] = [];

    /** Is this date in the calendar? Reads the per-instance cache below. */
    isHoliday(date: Temporal.PlainDate): boolean {
        return this.holidaySet().has(date.toString());
    }

    // A PlainDate is a value object with no useful identity, so the set is keyed by its ISO string.
    private holidaySet(): Set<string> {
        const rows = this.holidays ?? [];
        if (cachedFor.get(this) !== rows)
            holidayCache.set(this, new Set(rows.map(h => h.date?.toString()).filter((s): s is string => s != null)));
        cachedFor.set(this, rows);
        return holidayCache.get(this)!;
    }

    @quoted

    toString(): string {
        return this.name;
    }
}

// Per-instance memo, invalidated when the collection ARRAY itself is replaced (a row added in place is
// picked up by the length check the editor triggers on save).
const holidayCache = new WeakMap<HolidayCalendarEntity, Set<string>>();
const cachedFor = new WeakMap<HolidayCalendarEntity, HolidayCalendarEntity_Holiday[]>();

/** The same date twice is a data-entry mistake. */
function repeatedDates(calendar: HolidayCalendarEntity): string | null {
    const counts = new Map<string, number>();
    for (const h of calendar.holidays ?? []) {
        const key = h.date?.toString();
        if (key != null)
            counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const repeated = [...counts].filter(([, n]) => n > 1).map(([date, n]) => `${date} (${n})`);
    return repeated.length === 0 ? null : `${HolidayCalendarMessage.SomeDatesHaveBeenRepeated.niceToString()} ${repeated.join(", ")}`;
}

export namespace HolidayCalendarOperation {
    export const Save: ExecuteSymbol<HolidayCalendarEntity> = init();
    export const ImportPublicHolidays: ExecuteSymbol<HolidayCalendarEntity> = init();
    export const Delete: DeleteSymbol<HolidayCalendarEntity> = init();
}

export const HolidayCalendarMessage = {
    ForImport01and2ShouldBeSet: msg("For import {0}, {1} and {2} should be set."),
    SomeDatesHaveBeenRepeated: msg("Some dates have been repeated:"),
};
