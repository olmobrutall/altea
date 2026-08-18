import "@altea/altea/server"; // installs Entity.save()/delete()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import { Graph } from "@altea/altea/server/graph";
import {
    HolidayCalendarEntity, HolidayCalendarEntity_Holiday, HolidayCalendarOperation, HolidayCalendarMessage,
} from "../data/HolidayCalendar";
import { setHolidayCalendarResolver } from "../data/Scheduler";

// Port of Signum.Scheduler's HolidayCalendarLogic.cs — the calendar table, its cache, and the operations
// (Save / Delete / ImportPublicHolidays).
//
// altea divergences, documented inline:
//  - Signum caches `FrozenDictionary<Lite, Entity>` + the default calendar in two GlobalLazys; altea's
//    ResetLazy is ASYNC, so the caches are read with `await`. The schedule rules, however, evaluate
//    SYNCHRONOUSLY (`rule.next(now)` is isomorphic — the editors preview it too), so the runner warms the
//    cache before advancing any rule and the rules read it through a sync resolver installed here.
//  - `ImportPublicHolidays` calls the same third-party service Signum uses (date.nager.at) with the global
//    `fetch`; `GetCountries` / `GetSubDivisions` are ported alongside it for the editor's dropdowns.

export namespace HolidayCalendarLogic {

    /** Signum's `HolidayCalendarsByLite` — every calendar, by lite key. */
    export let calendarsByLite: ResetLazy<Map<string, HolidayCalendarEntity>> = null!;
    /** Signum's `DefaultHolidayCalendar`. */
    export let defaultHolidayCalendar: ResetLazy<HolidayCalendarEntity | undefined> = null!;

    // The synchronous view the schedule rules read (see setHolidayCalendarResolver). Filled by `warm()`.
    let warmCalendars: Map<string, HolidayCalendarEntity> = new Map();

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's WithQuery projection has no altea counterpart (no QueryDescription — the auto-query is
        // the entity itself); the columns the grid opens with are configured CLIENT-side, via
        // `cb.configure(HolidayCalendarEntity).withQuerySettings(...)`.
        sb.include(HolidayCalendarEntity)
            .withSave(HolidayCalendarOperation.Save)
            .withDelete(HolidayCalendarOperation.Delete)
            .withQuery();

        calendarsByLite = sb.globalLazy(
            async () => new Map((await table(HolidayCalendarEntity).toArray()).map(c => [c.toLite().key(), c])),
            { invalidateWith: [HolidayCalendarEntity, HolidayCalendarEntity_Holiday] });

        defaultHolidayCalendar = sb.globalLazy(
            async () => [...(await calendarsByLite.value()).values()].find(c => c.isDefault),
            { invalidateWith: [HolidayCalendarEntity, HolidayCalendarEntity_Holiday] });

        // A rule advancing to its next occurrence is SYNC, so it reads the warmed snapshot.
        setHolidayCalendarResolver(lite => warmCalendars.get(lite.key()));

        new Graph.Execute(HolidayCalendarOperation.ImportPublicHolidays, {
            canBeModified: true,
            canExecute: (c: HolidayCalendarEntity) => c.fromYear != null && c.toYear != null && (c.countryCode ?? "") !== "" ? null
                : HolidayCalendarMessage.ForImport01and2ShouldBeSet.niceToString("From year", "To year", "Country code"),
            execute: async (c: HolidayCalendarEntity) => { await importPublicHolidays(c); },
        }).register();
    }

    /** Refresh the SYNC snapshot the schedule rules read. Called by the runner before it (re)plans. */
    export async function warm(): Promise<void> {
        warmCalendars = await calendarsByLite.value();
    }

    /** Signum's `RetrieveFromCache`. */
    export async function retrieveFromCache(lite: Lite<HolidayCalendarEntity>): Promise<HolidayCalendarEntity> {
        const calendar = (await calendarsByLite.value()).get(lite.key());
        if (calendar == null)
            throw new Error(`HolidayCalendar '${lite.key()}' not found`);
        return calendar;
    }

    // ---- date.nager.at (Signum's ImportPublicHolidays / GetCountries / GetSubDivisions) ------------------

    /** Add every public holiday of the configured country + year range that the calendar does not have. */
    export async function importPublicHolidays(calendar: HolidayCalendarEntity): Promise<void> {
        for (let year = calendar.fromYear!; year <= calendar.toYear!; year++) {
            const holidays = await nagerHolidays(year, calendar.countryCode!);

            for (const holiday of holidays) {
                if (!(holiday.global || (holiday.counties ?? []).includes(calendar.subDivisionCode ?? "")))
                    continue;

                const date = Temporal.PlainDate.from(holiday.date);
                if (calendar.holidays.some(h => h.date?.equals(date)))
                    continue;

                calendar.holidays.push(HolidayCalendarEntity_Holiday.create({ date, name: holiday.localName }));
            }
        }

        await calendar.save();
    }

    export async function getCountries(): Promise<string[]> {
        const countries = await nagerGet<{ countryCode: string; name: string }[]>("AvailableCountries");
        return countries.map(c => c.countryCode);
    }

    export async function getSubDivisions(countryCode: string): Promise<string[]> {
        const holidays = await nagerHolidays(Clock.now.year, countryCode);
        return [...new Set(holidays.flatMap(h => h.counties ?? []))];
    }

    interface NagerHoliday {
        date: string;
        localName: string;
        name: string;
        countryCode: string;
        counties: string[] | null;
        global: boolean;
    }

    function nagerHolidays(year: number, countryCode: string): Promise<NagerHoliday[]> {
        return nagerGet<NagerHoliday[]>(`PublicHolidays/${year}/${countryCode}`);
    }

    async function nagerGet<T>(path: string): Promise<T> {
        const response = await fetch(`https://date.nager.at/api/v3/${path}`);
        if (!response.ok)
            throw new Error(`date.nager.at/${path} returned ${response.status} ${response.statusText}`);
        return await response.json() as T;
    }
}
