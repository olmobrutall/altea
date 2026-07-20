import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, LiteralType, ArrayType } from "../../../entities/runtimeTypes";
import {
    Expression, ParameterExpression, LambdaExpression, CallExpression, PropertyExpression,
    BinaryExpression, ConstantExpression,
} from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions } from "./queryToken";
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

// FilterOperation (string) → comparison operator, for `Count where <token> <op> <value>`.
const COMPARE_OP: Record<string, "==" | "!=" | ">" | ">=" | "<" | "<="> = {
    EqualTo: "==", DistinctTo: "!=", GreaterThan: ">", GreaterThanOrEqual: ">=", LessThan: "<", LessThanOrEqual: "<=",
};

// Port of Signum's `AggregateToken`: a group aggregate (Count / Sum / Min / Max / Average). `Count`
// with no parent is the group's row count; `Count` with a parent supports a filter (`Count where x >
// 0` → COUNT of matching rows) or Distinct (`CountDistinct` → count of distinct non-null values).
// Its own BuildExpression throws — GroupBy seeds it, computing it over the group's `elements`.
export class AggregateToken extends QueryToken {
    constructor(
        public readonly aggregateFunction: AggregateFunction,
        private readonly _parent: QueryToken | undefined,
        private readonly options: AggregateOptions = {},
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

    get type(): RuntimeType {
        if (this.aggregateFunction === AggregateFunction.Count || this.aggregateFunction === AggregateFunction.Average)
            return LiteralType.number;
        return this._parent!.type; // Sum / Min / Max keep the aggregated value's type
    }

    get format(): string | undefined { return this.aggregateFunction === AggregateFunction.Count ? undefined : this._parent?.format; }
    get unit(): string | undefined { return this.aggregateFunction === AggregateFunction.Count ? undefined : this._parent?.unit; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent?.isAllowed() ?? null; }

    protected buildExpressionInternal(_context: BuildExpressionContext): Expression {
        throw new Error("AggregateToken should have a replacement at this stage (built by GroupBy)");
    }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }

    // Build the aggregate over a group's `elements` (Signum's BuildAggregateExpressionEnumerable/
    // Queryable). Reuses the original row parameter for the value/predicate lambdas.
    buildAggregate(elements: Expression, groupContext: BuildExpressionContext): Expression {
        const rowParam = groupContext.parameter;

        if (this.aggregateFunction === AggregateFunction.Count) {
            if (this._parent == undefined)
                return new PropertyExpression(elements, "length"); // COUNT(*) of the group

            const body = this._parent.buildExpression(groupContext);

            if (this.options.distinct) {
                // COUNT(DISTINCT body): map → distinct → count of non-null.
                const mapped = new CallExpression(new PropertyExpression(elements, "map"),
                    [new LambdaExpression([rowParam], body)], new ArrayType(body.type));
                const distinct = new CallExpression(new PropertyExpression(mapped, "distinct"), [], mapped.type);
                const v = new ParameterExpression("_v", body.type);
                const notNull = new LambdaExpression([v], new BinaryExpression("!=", v, new ConstantExpression(null)));
                return new CallExpression(new PropertyExpression(distinct, "count"), [notNull], LiteralType.number);
            }

            // COUNT where <body> <op> <value>  (or non-null when no operation given).
            const predicate = this.options.filterOperation != undefined
                ? new BinaryExpression(COMPARE_OP[this.options.filterOperation], body, new ConstantExpression(this.options.value))
                : new BinaryExpression("!=", body, new ConstantExpression(null));
            return new CallExpression(new PropertyExpression(elements, "count"),
                [new LambdaExpression([rowParam], predicate)], LiteralType.number);
        }

        // Sum / Min / Max / Average → elements.<fn>(row => body).
        const body = this._parent!.buildExpression(groupContext);
        const method =
            this.aggregateFunction === AggregateFunction.Sum ? "sum" :
            this.aggregateFunction === AggregateFunction.Min ? "min" :
            this.aggregateFunction === AggregateFunction.Max ? "max" : "average";
        return new CallExpression(new PropertyExpression(elements, method),
            [new LambdaExpression([rowParam], body)], this.type);
    }
}
