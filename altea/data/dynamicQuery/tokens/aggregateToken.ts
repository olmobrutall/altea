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

    override toString(): string { return this._parent == undefined ? this.aggregateFunction : `${this.aggregateFunction} of ${this._parent.toString()}`; }
    niceName(): string { return this.toString(); }
    override isAggregate(): boolean { return true; }

    get type(): TypeReference {
        if (this.aggregateFunction === AggregateFunction.Count || this.aggregateFunction === AggregateFunction.Average)
            return TR_INT;
        return this._parent!.type; // Sum / Min / Max keep the aggregated value's type
    }

    get format(): string | undefined { return this.aggregateFunction === AggregateFunction.Count ? undefined : this._parent?.format; }
    get unit(): string | undefined { return this.aggregateFunction === AggregateFunction.Count ? undefined : this._parent?.unit; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent?.isAllowed() ?? null; }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
