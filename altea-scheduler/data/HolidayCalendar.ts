import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, backReference, rowOrder, stringLengthValidator, uniqueIndex, fieldValidation } from "@altea/altea/data/decorators";
import { Temporal, type int } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// Port of Signum.Scheduler's HolidayCalendarEntity.cs — a named set of dates that a weekday schedule rule
// consults, so a task can run "every weekday BUT holidays" (or only on them).
//
// altea divergences, documented inline:
//  - Signum's `MList<HolidayEmbedded> Holidays` → a `@part` collection row (altea has no MList), named by
//    the `<Owner>_<field singular>` convention.
//  - `DateOnly` → `Temporal.PlainDate`.
//  - The cached `Lazy<HashSet<DateOnly>>` behind `IsHoliday` is a per-instance Map built on first use; the
//    entity is a plain field bag, so it is rebuilt whenever the instance is (which is what Signum's
//    constructor-created Lazy effectively does too).
//  - `IUserAssetEntity` (XML import/export) is NOT ported — see SchedulerLogic for the deferral note.

@entity("Part")
export class HolidayCalendarEntity_Holiday extends Entity {
    @backReference calendar: Lite<HolidayCalendarEntity>;
    @rowOrder order: int;

    date: Temporal.PlainDate;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null = null;

    toString(): string {
        return `${this.date?.toString() ?? ""} ${this.name ?? ""}`.trim();
    }
}

@reflect
@entity("Shared", "Master")
// Signum's `.WithUniqueIndex(hc => hc.IsDefault, hc => hc.IsDefault)` — a FILTERED unique index, so at
// most one calendar is the default while any number are not.
@uniqueIndex<HolidayCalendarEntity>(c => c.isDefault, c => c.isDefault)
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

    @fieldValidation<HolidayCalendarEntity>(c => repeatedDates(c))
    holidays: HolidayCalendarEntity_Holiday[] = [];

    /** Signum's `IsHoliday` over its `Lazy<HashSet<DateOnly>>`. */
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

    toString(): string {
        return this.name;
    }
}

// Per-instance memo, invalidated when the collection ARRAY itself is replaced (a row added in place is
// picked up by the length check the editor triggers on save — Signum's Lazy has the same staleness).
const holidayCache = new WeakMap<HolidayCalendarEntity, Set<string>>();
const cachedFor = new WeakMap<HolidayCalendarEntity, HolidayCalendarEntity_Holiday[]>();

/** Signum's PropertyValidation on Holidays: the same date twice is a data-entry mistake. */
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

// Signum's `[AutoInit] static class HolidayCalendarOperation`.
export namespace HolidayCalendarOperation {
    export const Save: ExecuteSymbol<HolidayCalendarEntity> = init();
    export const ImportPublicHolidays: ExecuteSymbol<HolidayCalendarEntity> = init();
    export const Delete: DeleteSymbol<HolidayCalendarEntity> = init();
}

export const HolidayCalendarMessage = {
    ForImport01and2ShouldBeSet: msg("For import {0}, {1} and {2} should be set."),
    SomeDatesHaveBeenRepeated: msg("Some dates have been repeated:"),
};
