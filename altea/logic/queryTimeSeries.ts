import { View } from "../entities/entity";
import { Temporal } from "../entities/basics";
import { reflect } from "../entities/reflection";
import { viewPrimaryKey } from "../entities/decorators";
import { quotedFunction, Query } from "./query";
import { ArrayType, ClassType } from "../entities/runtimeTypes";
import { sqlMethodQuery } from "./table";
import type { SchemaAssets } from "./sync/schemaAssets";

// Port of Signum's Basics/QueryTimeSeriesLogic — the `GetDatesInRange` SQL table-valued function
// that generates a series of timestamps, used to drive time-series queries (a per-date AS OF over
// a system-versioned table, composed into a single query via OverrideSystemTime + AsOfExpression).
//
// `GetDatesInRange(start, end, unit, step)` returns one `DateValue { date }` row per step from
// start to end. SQL Server uses a multi-statement TVF with a WHILE loop (one branch per unit);
// Postgres a single `generate_series(start, end, '<step> <unit>'::interval)`. The UDF is
// registered on the schema's SchemaAssets (see includeGetDatesInRange), so schema generation
// creates it (Signum's QueryTimeSeriesLogic.Start).

// The row type of GetDatesInRange (Signum's `DateValue : IView`): one datetime column, never
// built into a Table — just reflected for its output column so the binder projects `dv.date`.
@reflect
export class DateValue extends View {
    @viewPrimaryKey date!: Temporal.PlainDateTime;
}

// The step unit of GetDatesInRange (Signum's TimeSeriesUnit). The string values are the
// `incrementType` the UDF branches on (SQL Server, case-insensitively) and the interval unit
// Postgres' `generate_series` accepts.
export enum TimeSeriesUnit {
    Millisecond = "millisecond",
    Second = "second",
    Minute = "minute",
    Hour = "hour",
    Day = "day",
    Week = "week",
    Month = "month",
    Quarter = "quarter",
    Year = "year",
}

// The [SqlMethod("GetDatesInRange")] marker (branded like MinimumExtensions' TVFs): the QueryBinder
// lowers a call to it into a `<schema>.GetDatesInRange(args)` table-valued source projecting a
// DateValue row. Query-only — the body throws if executed. Branded manually (rather than via the
// @sqlMethod/@returnType method decorators) because it is a free function, not a class static.
function getDatesInRangeMarker(_start: Temporal.PlainDateTime, _end: Temporal.PlainDateTime, _incrementType: string, _step: number): DateValue[] {
    throw new Error("getDatesInRange is a query-only SQL function marker.");
}
quotedFunction(getDatesInRangeMarker).__sqlMethod = "GetDatesInRange";
quotedFunction(getDatesInRangeMarker).__resultType = () => new ArrayType(new ClassType(DateValue));

// Signum's `QueryTimeSeriesLogic.GetDatesInRange(...)`: a top-level `Query<DateValue>` over the
// generated series, composable with `.map`/`.filter` etc. Each argument is parametrised into the
// TVF call.
export function getDatesInRange(startDate: Temporal.PlainDateTime, endDate: Temporal.PlainDateTime, incrementType: TimeSeriesUnit | string, step: number): Query<DateValue> {
    return sqlMethodQuery(getDatesInRangeMarker, DateValue, [startDate, endDate, incrementType, step]);
}

// Registers the GetDatesInRange UDF on the schema's assets so schema generation creates it
// (Signum's QueryTimeSeriesLogic.Start). Both dialect bodies are Signum's, adjusted to the exact
// form the synchronizer reads back (so SynchronizeTablesScriptEmpty stays empty) — the Postgres
// body matches pg_get_functiondef's canonical formatting, like MinimumExtensions.includeFunction.
export function includeGetDatesInRange(assets: SchemaAssets, isPostgres: boolean): void {
    if (isPostgres) {
        assets.includeUserDefinedFunction("GetDatesInRange", `(start_date timestamp with time zone, end_date timestamp with time zone, increment_type character varying, step integer)
 RETURNS TABLE(date timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
BEGIN
RETURN QUERY
SELECT generate_series(start_date, end_date, (step || ' ' || increment_type)::interval);
END;
$function$`);
    } else {
        assets.includeUserDefinedFunction("GetDatesInRange", `(
    @startDate DATETIME2,
    @endDate DATETIME2,
    @incrementType NVARCHAR(20),
    @step INT
)
RETURNS @DateRange TABLE
(
    Date DATETIME2 PRIMARY KEY
)
AS
BEGIN
    DECLARE @currentDate DATETIME2
    SET @currentDate = @startDate

    IF @incrementType = 'millisecond'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(MILLISECOND, @step, @currentDate)
        END
    END
    ELSE IF @incrementType = 'second'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(SECOND, @step, @currentDate)
        END
    END
    ELSE IF @incrementType = 'minute'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(MINUTE, @step, @currentDate)
        END
    END
    ELSE IF @incrementType = 'hour'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(HOUR, @step, @currentDate)
        END
    END
    ELSE IF @incrementType = 'day'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(DAY, @step, @currentDate)
        END
    END
    ELSE IF @incrementType = 'week'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(WEEK, @step, @currentDate)
        END
    END
    ELSE IF @incrementType = 'month'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(MONTH, @step, @currentDate)
        END
    END
    ELSE IF @incrementType = 'quarter'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(QUARTER, @step, @currentDate)
        END
    END
    ELSE IF @incrementType = 'year'
    BEGIN
        WHILE @currentDate <= @endDate
        BEGIN
            INSERT INTO @DateRange (Date) VALUES (@currentDate)
            SET @currentDate = DATEADD(YEAR, @step, @currentDate)
        END
    END

    RETURN
END`);
    }
}
