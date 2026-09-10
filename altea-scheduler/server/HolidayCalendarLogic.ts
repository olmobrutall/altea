import "@altea/altea/server"; // installs Entity.save()/delete()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import {
    HolidayCalendarEntity, HolidayCalendarEntity_Holiday, HolidayCalendarOperation, HolidayCalendarMessage,
} from "../data/HolidayCalendar";
import { setHolidayCalendarResolver } from "../data/Scheduler";
import "@altea/altea/server/fluentOperations";

// The calendar table, its cache, and the operations (Save / Delete / ImportPublicHolidays).
//
// **The caches are ASYNC while the schedule rules are SYNC** — `rule.next(now)` is isomorphic, and the
// editors preview it — so the runner WARMS the cache before advancing any rule, and the rules read it
// through the sync resolver installed here.
//
// See docs/port/Scheduler.md.

export namespace HolidayCalendarLogic {

    /** Every calendar, by lite key. */
    export let calendarsByLite: ResetLazy<Map<string, HolidayCalendarEntity>> = null!;
    /** The calendar a weekday rule uses when it names none. */
    export let defaultHolidayCalendar: ResetLazy<HolidayCalendarEntity | undefined> = null!;

    // The synchronous view the schedule rules read (see setHolidayCalendarResolver). Filled by `warm()`.
    let warmCalendars: Map<string, HolidayCalendarEntity> = new Map();

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // There is no server-side projection to register (the auto-query is
        // the entity itself); the columns the grid opens with are configured CLIENT-side, via
        // `cb.configure(HolidayCalendarEntity).withQuerySettings(...)`.
        sb.include(HolidayCalendarEntity)
            .withSave(HolidayCalendarOperation.Save)
            .withDelete(HolidayCalendarOperation.Delete)
            .withExecute(HolidayCalendarOperation.ImportPublicHolidays, {
                canBeModified: true,
                canExecute: (c: HolidayCalendarEntity) => c.fromYear != null && c.toYear != null && (c.countryCode ?? "") !== "" ? null
                    : HolidayCalendarMessage.ForImport01and2ShouldBeSet.niceToString("From year", "To year", "Country code"),
                execute: async (c: HolidayCalendarEntity) => { await importPublicHolidays(c); },
            })
            .withQuery();

        calendarsByLite = sb.globalLazy(
            async () => new Map((await table(HolidayCalendarEntity).toArray()).map(c => [c.toLite().key(), c])),
            { invalidateWith: [HolidayCalendarEntity, HolidayCalendarEntity_Holiday] });

        defaultHolidayCalendar = sb.globalLazy(
            async () => [...(await calendarsByLite.value()).values()].find(c => c.isDefault),
            { invalidateWith: [HolidayCalendarEntity, HolidayCalendarEntity_Holiday] });

        // A rule advancing to its next occurrence is SYNC, so it reads the warmed snapshot.
        setHolidayCalendarResolver(lite => warmCalendars.get(lite.key()));

    }

    /** Refresh the SYNC snapshot the schedule rules read. Called by the runner before it (re)plans. */
    export async function warm(): Promise<void> {
        warmCalendars = await calendarsByLite.value();
    }

    /** One calendar from the cache. */
    export async function retrieveFromCache(lite: Lite<HolidayCalendarEntity>): Promise<HolidayCalendarEntity> {
        const calendar = (await calendarsByLite.value()).get(lite.key());
        if (calendar == null)
            throw new Error(`HolidayCalendar '${lite.key()}' not found`);
        return calendar;
    }

    // ---- date.nager.at: import public holidays, and the editor's country / subdivision lists ------------

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