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
// The `Every0…` four are the same token with a STEP: `Every 6 Hours` buckets 13:45 into 12:00, which is
// how a chart plots a day in four points. One token per (name, step) pair, exactly as Signum lists them.
//
// altea divergences:
//  - the member each one lowers to is altea's own Temporal extension (`data/globals/dateTimeExtensions`),
//    which the LINQ nominator already translates to `date_trunc` / `DATETRUNC` — so the SQL half of this
//    token existed before the token did, and it works in memory too.
//  - no `Priority`: Signum orders these by the QueryTokenDateMessage ordinal, altea's date sub-tokens
//    carry no priorities at all and sort by display name.
export type DatePartStartName =
    | "QuarterStart" | "MonthStart" | "WeekStart" | "HourStart" | "MinuteStart" | "SecondStart"
    | "Every0Hours" | "Every0Minutes" | "Every0Seconds" | "Every0Milliseconds";

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
    Every0Hours: { member: "truncHours", format: "g", needsTime: true },
    Every0Minutes: { member: "truncMinutes", format: "g", needsTime: true },
    Every0Seconds: { member: "truncSeconds", format: "G", needsTime: true },
    Every0Milliseconds: { member: "truncMilliseconds", format: "G", needsTime: true },
};

export class DatePartStartToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly name: DatePartStartName, public readonly step?: number) {
        super();
    }

    /** The Temporal extension this token calls (`monthStart`, `truncHours`, …). */
    get member(): string { return datePartStarts[this.name].member; }

    get parent(): QueryToken | undefined { return this._parent; }
    // Signum's Key: the step replaces the "0" of the message name, so `Every0Hours` at step 6 is stored
    // as `Every6Hours` — one stable key per offered bucket size.
    get key(): string { return this.step == undefined ? this.name : this.name.replace("0", String(this.step)); }
    override toString(): string {
        const message = QueryTokenDateMessage[this.name];
        return this.step == undefined ? message.niceToString() : message.niceToString(this.step);
    }
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
