import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { TypeReference } from "../../reflection";
import { QueryTokenDateMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions } from "./queryToken";

// Port of Signum's `DatePartStartToken` (DynamicQuery/Tokens/DateTimeSpecialTokens.cs): the START of the
// period a date falls in — `MonthStart` of 2026-09-07 is 2026-09-01. It is what a chart groups by when
// it wants one point per month while keeping a real DATE on the axis (Southwind's dashboards are built
// on `OrderDate.MonthStart`), which `Month` alone cannot do: that is the number 9, so two Septembers a
// year apart collapse into one bucket and the axis has no chronology.
//
// altea divergences:
//  - the STEPPED variants are not ported (Signum's `Every0Hours` / `Every0Minutes` / `Every0Seconds` /
//    `Every0Milliseconds`, which carry a `Step` and a "{0}" message). They are the same shape and can be
//    added when something needs them; altea leaves out the sibling numeric `StepTokens` for the same
//    reason.
//  - the member each one lowers to is altea's own Temporal extension (`data/globals/dateTimeExtensions`),
//    which the LINQ nominator already translates to `date_trunc` / `DATEADD(DATEDIFF(…))` — so the SQL
//    half of this token existed before the token did, and it works in memory too.
//  - no `Priority`: Signum orders these by the QueryTokenDateMessage ordinal, altea's date sub-tokens
//    carry no priorities at all and sort by display name.
export type DatePartStartName = "QuarterStart" | "MonthStart" | "WeekStart" | "HourStart" | "MinuteStart" | "SecondStart";

interface DatePartStartInfo {
    /** The Temporal extension the expression calls — what the nominator lowers. */
    readonly member: string;
    /** Signum's per-name Format. */
    readonly format: string;
    /** Truncates a TIME, so it is offered on a PlainDateTime only. */
    readonly needsTime: boolean;
}

export const datePartStarts: { readonly [K in DatePartStartName]: DatePartStartInfo } = {
    QuarterStart: { member: "quarterStart", format: "d", needsTime: false },
    MonthStart: { member: "monthStart", format: "Y", needsTime: false },
    WeekStart: { member: "weekStart", format: "d", needsTime: false },
    HourStart: { member: "truncHours", format: "g", needsTime: true },
    MinuteStart: { member: "truncMinutes", format: "g", needsTime: true },
    SecondStart: { member: "truncSeconds", format: "G", needsTime: true },
};

export class DatePartStartToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly name: DatePartStartName) {
        super();
    }

    /** The Temporal extension this token calls (`monthStart`, `truncHours`, …). */
    get member(): string { return datePartStarts[this.name].member; }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.name; }
    override toString(): string { return QueryTokenDateMessage[this.name].niceToString(); }
    niceName(): string { return `${this.toString()} of ${this._parent.toString()}`; }

    // Signum's `Parent!.Type.Nullify()`: truncating a date yields the same kind of date. Copied rather
    // than shared — the parent's TypeReference may be a live FieldInfo, which must not be mutated.
    get type(): TypeReference {
        return Object.assign(new TypeReference(), this._parent.type, { isNullable: true });
    }

    get format(): string | undefined { return datePartStarts[this.name].format; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    // Signum returns none: the truncated value is a leaf. Without this the token would re-expose the
    // whole date family off itself, so `MonthStart.MonthStart.MonthStart` would be a legal token.
    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
