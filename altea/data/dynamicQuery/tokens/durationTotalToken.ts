import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import type { TypeReference } from "../../reflection";
import { QueryTokenDateMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions, TR_DECIMAL } from "./queryToken";

// The `Total…` half of Signum's TimeSpanProperties (`TimeSpan.TotalMinutes`, …): the WHOLE duration
// measured in one unit, as opposed to the balanced component beside it — `PT1H30M` has `Minutes` 30 but
// `TotalMinutes` 90.
//
// Signum reaches these through a PropertyInfo on TimeSpan; altea has no such member, because Temporal
// spells it `duration.total(unit)`. So the unit is the token's own state and the expression it builds is
// that call — which is also why there is one token class rather than five ObjectPropertyTokens: the
// member name is the same for all of them and only the argument differs.
export type DurationTotalName = "TotalDays" | "TotalHours" | "TotalMinutes" | "TotalSeconds" | "TotalMilliseconds";

const totalUnits: { readonly [K in DurationTotalName]: string } = {
    TotalDays: "days",
    TotalHours: "hours",
    TotalMinutes: "minutes",
    TotalSeconds: "seconds",
    TotalMilliseconds: "milliseconds",
};

export class DurationTotalToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly name: DurationTotalName) {
        super();
    }

    /** The Temporal unit passed to `total(…)` — what the nominator turns into a DATEDIFF part / divisor. */
    get totalUnit(): string { return totalUnits[this.name]; }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.name; }
    override toString(): string { return QueryTokenDateMessage[this.name].niceToString(); }
    niceName(): string { return `${this.toString()} of ${this._parent.toString()}`; }
    get type(): TypeReference { return TR_DECIMAL; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    // A number, and a leaf: Signum's NetPropertyToken over a double would offer the numeric modulo
    // buckets, which mean nothing over a fractional measure.
    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
