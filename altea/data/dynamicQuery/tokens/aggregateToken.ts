import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import type { TypeReference } from "../../reflection";
import { QueryToken, SubTokensOptions, TR_INT } from "./queryToken";
import type { QueryName } from "../queryUtils";

// Signum's AggregateFunction (DynamicQuery/Tokens/AggregateToken.cs).
export enum AggregateFunction {
    Count = "Count",
    Average = "Average",
    Sum = "Sum",
    Min = "Min",
    Max = "Max",
}

// Signum's `" ".Combine(...)`: join the non-empty parts with a single space.
function combineSpaced(...parts: (string | undefined)[]): string {
    return parts.filter((p): p is string => p != undefined && p !== "").join(" ");
}

// Count variants (Signum's FilterOperation? + Distinct on AggregateToken). `filterOperation` is a
// string (the FilterOperation enum value) to avoid an import cycle with requests.ts.
export interface AggregateOptions {
    filterOperation?: string;
    value?: unknown;
    distinct?: boolean;
    queryName?: QueryName;
}

// Port of Signum's `AggregateToken`: a group aggregate (Count / Sum / Min / Max / Average). `Count`
// with no parent is the group's row count; `Count` with a parent supports a filter (`Count where x >
// 0` → COUNT of matching rows) or Distinct (`CountDistinct` → count of distinct non-null values).
// Its own BuildExpression throws — GroupBy seeds it, computing it over the group's `elements`.
export class AggregateToken extends QueryToken {
    constructor(
        public readonly aggregateFunction: AggregateFunction,
        private readonly _parent: QueryToken | undefined,
        public readonly options: AggregateOptions = {},
    ) {
        super();
        if (aggregateFunction !== AggregateFunction.Count && _parent == undefined)
            throw new Error(`Aggregate ${aggregateFunction} requires a parent token`);
        this.priority = 10;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    override get queryName(): QueryName { return this._parent?.queryName ?? this.options.queryName!; }

    get key(): string {
        const distinct = this.options.distinct ? "Distinct" : "";
        const op = this.options.filterOperation == undefined ? "" :
            this.options.filterOperation === "EqualTo" ? "" :
                this.options.filterOperation === "DistinctTo" ? "Not" : this.options.filterOperation;
        const value = this.options.filterOperation == undefined ? "" : this.options.value == undefined ? "Null" : String(this.options.value);
        return this.aggregateFunction + distinct + op + value;
    }

    // Signum's AggregateToken.ToString: ONLY the function (+ Distinct / operation / value) — NO parent.
    // The QueryTokenBuilder chip renders this (Signum's `toStr`), so a "Sum of Unit price" column shows
    // just "Sum" in the token dropdown. The parent-qualified label lives in niceName (the column name).
    override toString(): string {
        return combineSpaced(this.aggregateFunction, this.niceDistinct(), this.niceOperation(), this.niceValue());
    }

    // Signum's AggregateToken.NiceName: the parent-qualified label used as the column header
    // ("Count", "Sum of Unit price", "Count Not Null Unit price"). Divergence: Signum renders Sum as
    // "Σ <parent>"; altea keeps the spelled-out "Sum of <parent>" (reads better as a column title).
    niceName(): string {
        if (this.aggregateFunction === AggregateFunction.Count) {
            if (this._parent == undefined)
                return this.aggregateFunction;
            return combineSpaced(this.aggregateFunction, this.niceDistinct(), this.niceOperation(), this.niceValue(), this._parent.toString());
        }
        return combineSpaced(this.aggregateFunction, this.niceDistinct(), this.niceOperation(), this.niceValue(), "of", this._parent!.toString());
    }

    // Signum's GeNiceDistinct / GetNiceOperation / GetNiceValue — the Count-variant qualifiers.
    // altea's enum members ARE their display strings (bare literals), so no niceToString lookup.
    private niceDistinct(): string | undefined { return this.options.distinct ? "Distinct" : undefined; }
    private niceOperation(): string | undefined {
        const op = this.options.filterOperation;
        return op == undefined || op === "EqualTo" ? undefined : op === "DistinctTo" ? "Not" : op;
    }
    private niceValue(): string | undefined {
        if (this.options.filterOperation == undefined) return undefined;
        return this.options.value == undefined ? "Null" : String(this.options.value);
    }
    override isAggregate(): boolean { return true; }
    // Signum's AggregateToken.HideInAutoExpand => Parent != null (a nested aggregate is hidden from a
    // flattened list; the root Count of the group stays visible).
    override get hideInAutoExpand(): boolean { return this._parent != undefined; }

    get type(): TypeReference {
        if (this.aggregateFunction === AggregateFunction.Count || this.aggregateFunction === AggregateFunction.Average)
            return TR_INT;
        return this._parent!.type; // Sum / Min / Max keep the aggregated value's type
    }

    // Signum's AggregateToken.Format/Unit: Count has neither; every other aggregate inherits its
    // parent's @format / @unit (so "Sum of Unit price" keeps "€"). Special case (Signum): an Average
    // over an integer column (parent format "D") renders as "N2" — the average of ints is fractional.
    get format(): string | undefined {
        if (this.aggregateFunction === AggregateFunction.Count)
            return undefined;
        if (this.aggregateFunction === AggregateFunction.Average && this._parent?.format === "D")
            return "N2";
        return this._parent?.format;
    }
    get unit(): string | undefined { return this.aggregateFunction === AggregateFunction.Count ? undefined : this._parent?.unit; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent?.isAllowed() ?? null; }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
