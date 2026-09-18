import { reflect, init, setDefaultDatabaseSchema, MAX_SIZE } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Symbol } from "@altea/altea/data/symbol";
import {
    entity, part, implementedBy, implementedByAll, format, unit, quoted, primaryKey, legacyPropertyRoute, column,
} from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, ValidationMessage } from "@altea/altea/data/validators";
import { Temporal, type int } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import type { IUserEntity } from "@altea/altea/data/security";
import { ExceptionEntity } from "@altea/altea/data/exception";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";
import { HolidayCalendarEntity } from "./HolidayCalendar";

// A ScheduledTask pairs a TASK (what to run) with a RULE (when), and every run is logged.
//
// The rules do their arithmetic in the server's LOCAL time, and a `Temporal.PlainDateTime` is exactly that
// — a wall-clock instant with no zone — so the translation is literal. `Clock.now` is the testable clock
// every rule reads.
//
// `IScheduleRuleEntity` / `ITaskEntity` are TS interfaces extending the `Entity` CLASS (the shape
// data/security.ts uses for IUserEntity). `clone()` is kept — the ScheduledTask editor clones a rule when
// switching type.
//
// Port of Signum.Scheduler's ScheduleRuleEntities.cs + ScheduledTaskEntity.cs + ScheduledTaskLogEntity.cs
// + SimpleTask.cs — see port/Scheduler.md.

/** What a ScheduledTask runs. Implemented by SimpleTaskSymbol here, and by any
 *  entity an app registers with `SchedulerLogic.executeTask`. */
export interface ITaskEntity extends Entity { }

/** When a ScheduledTask runs. */
export interface IScheduleRuleEntity extends Entity {
    startingOn: Temporal.PlainDateTime;
    /** The first occurrence at or after `now`. */
    next(now: Temporal.PlainDateTime): Temporal.PlainDateTime;
    clone(): IScheduleRuleEntity;
}

// ---- Schedule rules -------------------------------------------------------------------------------------

// Every N minutes.
@reflect
@part
// Signum declares this `[PrimaryKey(typeof(Guid))]`.
@primaryKey("uuid")
export class ScheduleRuleMinutelyEntity extends Entity implements IScheduleRuleEntity {

    startingOn: Temporal.PlainDateTime = startOfToday();

    // Greater than zero. There is no numeric comparison
    // validator, so the same check is a field validation.
    @validate<ScheduleRuleMinutelyEntity>(r => r.eachMinutes > 0 ? null
        : ValidationMessage.NumberIsTooSmall.niceToString())
    eachMinutes: int;

    /** A divisor of an hour lands on the clock (:00, :15, :30…), anything else drifts. */
    get isAligned(): boolean {
        return this.eachMinutes > 0 && this.eachMinutes < 60 && 60 % this.eachMinutes === 0;
    }

    next(now: Temporal.PlainDateTime): Temporal.PlainDateTime {
        let candidate = max(now, this.startingOn).with({ second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });

        if (this.isAligned)
            candidate = candidate.add({ minutes: -(candidate.minute % this.eachMinutes) });

        if (Temporal.PlainDateTime.compare(candidate, now) < 0)
            candidate = candidate.add({ minutes: this.eachMinutes });

        return candidate;
    }

    clone(): IScheduleRuleEntity {
        return ScheduleRuleMinutelyEntity.create({ eachMinutes: this.eachMinutes, startingOn: this.startingOn });
    }

    toString(): string {
        return SchedulerMessage.Each0Minutes.niceToString(this.eachMinutes);
    }
}

// On the chosen weekdays, at StartingOn's time of day, optionally
// including or excluding a calendar's holidays.
@reflect
@part
// Signum declares this `[PrimaryKey(typeof(Guid))]`.
@primaryKey("uuid")
export class ScheduleRuleWeekDaysEntity extends Entity implements IScheduleRuleEntity {

    startingOn: Temporal.PlainDateTime = startOfToday();

    // At least ONE of the seven (or Holiday) must be set. The rule attaches to the
    // same check to the first field, so the message lands on the same line.
    @validate<ScheduleRuleWeekDaysEntity>(r => r.anyDaySelected() ? null
        : ValidationMessage._0IsNotSet.niceToString(SchedulerMessage.ScheduleRuleWeekDaysDN_Mo.niceToString()))
    monday: boolean = false;
    tuesday: boolean = false;
    wednesday: boolean = false;
    thursday: boolean = false;
    friday: boolean = false;
    saturday: boolean = false;
    sunday: boolean = false;

    calendar: Lite<HolidayCalendarEntity> | null = null;

    /** With a calendar: true = run ONLY on its holidays, false = skip them. */
    holiday: boolean = false;

    anyDaySelected(): boolean {
        return this.monday || this.tuesday || this.wednesday || this.thursday
            || this.friday || this.saturday || this.sunday || this.holiday;
    }

    next(now: Temporal.PlainDateTime): Temporal.PlainDateTime {
        let result = max(now, this.startingOn).with({
            hour: this.startingOn.hour, minute: this.startingOn.minute, second: this.startingOn.second,
            millisecond: 0, microsecond: 0, nanosecond: 0,
        });

        if (Temporal.PlainDateTime.compare(result, now) < 0)
            result = result.add({ days: 1 });

        // Bounded: a rule with nothing selected fails validation, and a
        // calendar cannot make every day a holiday for more than a year without the user meaning it.
        for (let i = 0; i < 366 && !this.isAllowed(result); i++)
            result = result.add({ days: 1 });

        return result;
    }

    // altea divergence: the holiday lookup needs the CALENDAR ENTITY, and altea holds a Lite. The runner
    // resolves it (HolidayCalendarLogic.resolve) before asking; unresolved, a holiday is simply not one.
    isAllowed(dateTime: Temporal.PlainDateTime): boolean {
        const calendar = this.calendar == null ? undefined : resolveCalendar?.(this.calendar);
        if (calendar != null && calendar.isHoliday(dateTime.toPlainDate()))
            return this.holiday;

        switch (dateTime.dayOfWeek) { // Temporal: 1 = Monday … 7 = Sunday
            case 1: return this.monday;
            case 2: return this.tuesday;
            case 3: return this.wednesday;
            case 4: return this.thursday;
            case 5: return this.friday;
            case 6: return this.saturday;
            case 7: return this.sunday;
            default: throw new Error(`Unexpected day of week ${dateTime.dayOfWeek}`);
        }
    }

    clone(): IScheduleRuleEntity {
        return ScheduleRuleWeekDaysEntity.create({
            calendar: this.calendar, holiday: this.holiday, startingOn: this.startingOn,
            monday: this.monday, tuesday: this.tuesday, wednesday: this.wednesday, thursday: this.thursday,
            friday: this.friday, saturday: this.saturday, sunday: this.sunday,
        });
    }

    toString(): string {
        const days = [
            this.monday && SchedulerMessage.ScheduleRuleWeekDaysDN_Mo,
            this.tuesday && SchedulerMessage.ScheduleRuleWeekDaysDN_Tu,
            this.wednesday && SchedulerMessage.ScheduleRuleWeekDaysDN_We,
            this.thursday && SchedulerMessage.ScheduleRuleWeekDaysDN_Th,
            this.friday && SchedulerMessage.ScheduleRuleWeekDaysDN_Fr,
            this.saturday && SchedulerMessage.ScheduleRuleWeekDaysDN_Sa,
            this.sunday && SchedulerMessage.ScheduleRuleWeekDaysDN_Su,
        ].filter(m => m !== false).map(m => (m as { niceToString(): string }).niceToString()).join("");

        const holidays = this.calendar == null ? "" :
            (this.holiday ? SchedulerMessage.ScheduleRuleWeekDaysDN_AndHoliday : SchedulerMessage.ScheduleRuleWeekDaysDN_ButHoliday).niceToString();

        return [days, holidays, SchedulerMessage.ScheduleRuleWeekDaysDN_At.niceToString(), shortTime(this.startingOn)]
            .filter(s => s !== "").join(" ");
    }
}

// On StartingOn's day-of-month and time, in the chosen months.
@reflect
@part
// Signum declares this `[PrimaryKey(typeof(Guid))]`.
@primaryKey("uuid")
export class ScheduleRuleMonthsEntity extends Entity implements IScheduleRuleEntity {

    startingOn: Temporal.PlainDateTime = startOfToday();

    @validate<ScheduleRuleMonthsEntity>(r => r.anyMonthSelected() ? null
        : ValidationMessage._0IsNotSet.niceToString(SchedulerMessage.January.niceToString()))
    january: boolean = false;
    february: boolean = false;
    march: boolean = false;
    april: boolean = false;
    may: boolean = false;
    june: boolean = false;
    july: boolean = false;
    august: boolean = false;
    september: boolean = false;
    october: boolean = false;
    november: boolean = false;
    december: boolean = false;

    anyMonthSelected(): boolean {
        return this.months().some(m => m);
    }

    // Index 0 = January.
    months(): boolean[] {
        return [this.january, this.february, this.march, this.april, this.may, this.june,
        this.july, this.august, this.september, this.october, this.november, this.december];
    }

    next(now: Temporal.PlainDateTime): Temporal.PlainDateTime {
        const startingOn = this.startingOn;
        const base = max(now, startingOn);

        // The same day-of-month and time, this month.
        // `constrain` keeps a 31st landing on the 30th of a short month rather than throwing.
        let result = base.with({
            day: 1, hour: startingOn.hour, minute: startingOn.minute, second: startingOn.second,
            millisecond: 0, microsecond: 0, nanosecond: 0,
        }).add({ days: startingOn.day - 1 }, { overflow: "constrain" });

        if (Temporal.PlainDateTime.compare(result, now) < 0)
            result = result.add({ months: 1 });

        for (let i = 0; i < 12 && !this.months()[result.month - 1]; i++)
            result = result.add({ months: 1 });

        return result;
    }

    clone(): IScheduleRuleEntity {
        const clone = ScheduleRuleMonthsEntity.create({ startingOn: this.startingOn });
        const flags = this.months();
        (["january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december"] as const)
            .forEach((name, i) => { clone[name] = flags[i]; });
        return clone;
    }

    toString(): string {
        const names = this.months()
            .map((selected, i) => selected ? monthName(i + 1) : null)
            .filter((n): n is string => n != null)
            .join(", ");

        return SchedulerMessage.Day0At1In2.niceToString(this.startingOn.day, shortTime(this.startingOn), names);
    }
}

// ---- Tasks ----------------------------------------------------------------------------------------------

// A task that IS just a registered function (SimpleTaskLogic.register).
@reflect
@entity("SystemString", "Master")
export class SimpleTaskSymbol extends Symbol implements ITaskEntity {
}

// The pairing of a task with a rule, optionally pinned to one machine.
@reflect
@entity("Main", "Master")
export class ScheduledTaskEntity extends Entity {

    /** Declared first so the field initializers below can read it. */
    static readonly None = "none";

    @implementedBy(() => [ScheduleRuleMinutelyEntity, ScheduleRuleWeekDaysEntity, ScheduleRuleMonthsEntity])
    rule: IScheduleRuleEntity;

    // The app OVERRIDES this with its own task types (EntityOverrides.overrideImplementedBy) — the same
    // channel altea uses elsewhere so a framework entity needn't reference the app's.
    @implementedBy(() => [SimpleTaskSymbol])
    task: ITaskEntity;

    suspended: boolean = false;

    /** "none" runs on every host; anything else only on the machine of that name. */
    @stringLengthValidator({ min: 3, max: 100 })
    machineName: string = ScheduledTaskEntity.None;

    // The USER a run acts as. There is no runtime interface to reference, so the field needs
    // it on the field, and this package already depends on altea-auth — so name UserEntity and get a real FK
    // (core entities like ExceptionEntity use @implementedByAll instead, because CORE cannot import auth).
    @implementedBy(() => [UserEntity])
    user: Lite<IUserEntity>;

    @stringLengthValidator({ min: 3, max: 100 })
    applicationName: string = ScheduledTaskEntity.None;

    toString(): string {
        return `${this.task ?? ""} ${this.rule ?? ""}`.trim()
            + (this.suspended ? ` [${ScheduledTaskMessage.Suspended.niceToString()}]` : "");
    }
}

// One run: when, by whom, on which host, and what came out.
@reflect
@entity("System", "Transactional")
export class ScheduledTaskLogEntity extends Entity {

    @implementedBy(() => [SimpleTaskSymbol])
    task: ITaskEntity;

    scheduledTask: Lite<ScheduledTaskEntity> | null = null;

    @implementedBy(() => [UserEntity])
    user: Lite<IUserEntity>;

    @format("G")
    startTime: Temporal.PlainDateTime;

    @format("G")
    endTime: Temporal.PlainDateTime | null = null;

    @stringLengthValidator({ min: 3, max: 200 })
    machineName: string;

    @stringLengthValidator({ min: 3, max: 200 })
    applicationName: string;

    /** Whatever the task produced, for a "go look at it" link. */
    @implementedByAll
    productEntity: Lite<Entity> | null = null;

    exception: Lite<ExceptionEntity> | null = null;

    /** What the task wrote as it ran (ScheduledTaskContext.stringBuilder). Unbounded, so — like
     *  Unbounded, so no max here either. */
    @stringLengthValidator({ multiLine: true })
    remarks: string | null;

    /**
     * Signum's `[ExpressionField("DurationExpression"), Unit("ms")] public double? Duration` — how long the
     * run took, null while `endTime` is unset (a run still going, or one killed before it could stamp an
     * end). `@quoted`, so the log's search page can order and filter by it.
     *
     * The guard is load-bearing: a difference taken against a NULL `endTime` would report a wrong number
     * instead of "unknown". The ternary lowers to a CASE WHEN and `since().total({ unit })` to a real
     * DATEDIFF — a note here used to claim the opposite (that a quoted duration was impossible because
     * `int` is a branded type with no runtime value); the return type is plain `number`, which has one.
     *
     * It must be written VALUE-FIRST (`endTime != null ? … : null`): `ConditionalExpression.calculateType`
     * is `whenTrue.type || whenFalse.type` and the `null` literal HAS a type, so a null-first ternary
     * types the whole expression as null and the registration rejects it.
     *
     * `@legacyPropertyRoute("Duration")`: Signum's member is a C# PROPERTY, so a Signum database carries a
     * `basics.property_route` row under that name, and altea renamed the member.
     */
    @legacyPropertyRoute("Duration")
    @quoted durationMilliseconds(): number | null {
        return this.endTime != null
            ? this.endTime.since(this.startTime).total({ unit: "milliseconds" }) : null;
    }

    toString(): string {
        if (this.endTime != null)
            return `${this.startTime}-${this.endTime}`;
        if (this.exception != null)
            return `${this.startTime} Error: ${this.exception}`;
        return String(this.startTime);
    }
}

// One failed element inside a task that iterates (see the
// runner's ScheduledTaskContext.forEach), so one bad row does not lose the whole run.
@reflect
@entity("System", "Transactional")
export class SchedulerTaskExceptionLineEntity extends Entity {
    // An unbounded text column (Signum's [DbType(Size = int.MaxValue)]), so a plain string column behind
    // a non-null embedded whose text is nullable. Said outright: no size means the default of 200.
    @column({ size: MAX_SIZE })
    elementInfo: string | null;

    schedulerTaskLog: Lite<ScheduledTaskLogEntity> | null = null;

    exception: Lite<ExceptionEntity>;
}

// ---- Operations / permissions / messages -----------------------------------------------------------------

export namespace ScheduledTaskOperation {
    export const Save: ExecuteSymbol<ScheduledTaskEntity> = init();
    export const Delete: DeleteSymbol<ScheduledTaskEntity> = init();
}

export namespace ScheduledTaskLogOperation {
    export const CancelRunningTask: ExecuteSymbol<ScheduledTaskLogEntity> = init();
}

export namespace ITaskOperation {
    /** Run a task NOW, from its own view. */
    export const ExecuteSync: ConstructSymbol<ScheduledTaskLogEntity, From<ITaskEntity>> = init();
}

export namespace SchedulerPermission {
    export const ViewSchedulerPanel: PermissionSymbol = init();
}

export const ITaskMessage = {
    Execute: msg(),
    Executions: msg(),
    LastExecution: msg("Last execution"),
    ExceptionLines: msg("Exception lines"),
};

export const SchedulerMessage = {
    Each0Minutes: msg("Each {0} minutes"),
    ScheduleRuleWeekDaysDN_AndHoliday: msg("and holidays"),
    ScheduleRuleWeekDaysDN_At: msg("at"),
    ScheduleRuleWeekDaysDN_ButHoliday: msg("but holidays"),
    ScheduleRuleWeekDaysDN_Mo: msg("Mo"),
    ScheduleRuleWeekDaysDN_Tu: msg("Tu"),
    ScheduleRuleWeekDaysDN_We: msg("We"),
    ScheduleRuleWeekDaysDN_Th: msg("Th"),
    ScheduleRuleWeekDaysDN_Fr: msg("Fr"),
    ScheduleRuleWeekDaysDN_Sa: msg("Sa"),
    ScheduleRuleWeekDaysDN_Su: msg("Su"),
    Day0At1In2: msg("Day {0} at {1} in {2}"),
    TaskIsNotRunning: msg("Task is not running"),
    Holiday: msg(),
    SelectAll: msg("Select all"),
    January: msg(),
};

export const ScheduledTaskMessage = {
    State: msg(),
    // The caption of the `Duration` token over ScheduledTaskLogEntity.durationMilliseconds() (registered in
    // SchedulerLogic). Signum translates it as that entity's `Duration` PROPERTY; altea's member is a
    // `@quoted` method, which is not a PropertyRoute and so has no <Member> row of its own to hold a
    // translation — `stub-translations` builds a type's member list from PropertyRoute.memberPaths, i.e.
    // from FIELDS. A message is the localizable home that leaves.
    Duration: msg(),
    InitialDelayMilliseconds: msg("Initial delay milliseconds"),
    SchedulerMargin: msg("Scheduler margin"),
    MachineName: msg("Machine name"),
    ApplicationName: msg("Application name"),
    ServerTimeZone: msg("Server time zone"),
    ServerLocalTime: msg("Server local time"),
    NextExecution: msg("Next execution"),
    InMemoryQueue: msg("In memory queue"),
    RunningTasks: msg("Running tasks"),
    AvailableTasks: msg("Available tasks"),
    Rule: msg(),
    NextDate: msg("Next date"),
    ScheduledTask: msg("Scheduled task"),
    Running: msg("RUNNING"),
    Stopped: msg("STOPPED"),
    None: msg(),
    SimpleStatus: msg("Simple status"),
    ThereIsNoActiveScheduledTask: msg("There is no active scheduled task"),
    ThereAreNoTasksRunning: msg("There are no tasks running"),
    SchedulerTaskLog: msg("Scheduler task log"),
    StartTime: msg("Start time"),
    Remarks: msg(),
    Cancel: msg(),
    SchedulePanel: msg("Schedule panel"),
    Start: msg(),
    Stop: msg(),
    Dates: msg(),
    Suspended: msg(),
};

// ---- helpers ---------------------------------------------------------------------------------------------

// A rule's holiday lookup needs the calendar ENTITY behind its Lite. The server installs a resolver
// (HolidayCalendarLogic's cache); on the client the rules are only ever displayed, never advanced.
let resolveCalendar: ((lite: Lite<HolidayCalendarEntity>) => HolidayCalendarEntity | undefined) | undefined;
export function setHolidayCalendarResolver(resolver: (lite: Lite<HolidayCalendarEntity>) => HolidayCalendarEntity | undefined): void {
    resolveCalendar = resolver;
}

function startOfToday(): Temporal.PlainDateTime {
    return Clock.now.toPlainDate().toPlainDateTime();
}

function max(a: Temporal.PlainDateTime, b: Temporal.PlainDateTime): Temporal.PlainDateTime {
    return Temporal.PlainDateTime.compare(a, b) >= 0 ? a : b;
}

function shortTime(dateTime: Temporal.PlainDateTime): string {
    return dateTime.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function monthName(month: number): string {
    return new Date(2000, month - 1, 1).toLocaleString(undefined, { month: "short" });
}

setDefaultDatabaseSchema("scheduler");
