import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, LiteralType } from "../../../entities/runtimeTypes";
import { Expression, LambdaExpression, CallExpression, PropertyExpression } from "../../linq/expressions";
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

// Port of Signum's `AggregateToken`: a group aggregate (Count / Sum / Min / Max / Average). `Count`
// with no parent is the group's row count; the others aggregate a parent token's value. Its own
// BuildExpression throws — GroupBy seeds it in the replacements, computing it over the group's
// `elements` via `buildAggregate`.
export class AggregateToken extends QueryToken {
    constructor(
        public readonly aggregateFunction: AggregateFunction,
        private readonly _parent: QueryToken | undefined,
        private readonly _queryName?: QueryName,
    ) {
        super();
        if (aggregateFunction !== AggregateFunction.Count && _parent == undefined)
            throw new Error(`Aggregate ${aggregateFunction} requires a parent token`);
        this.priority = 10;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    override get queryName(): QueryName { return this._parent?.queryName ?? this._queryName!; }

    get key(): string { return this.aggregateFunction; }
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

    // Build the aggregate over a group's `elements` expression (Signum's
    // BuildAggregateExpressionEnumerable/Queryable). Count(no parent) → `elements.length`; the rest →
    // `elements.<fn>(row => <parent value>)`, reusing the original row parameter.
    buildAggregate(elements: Expression, groupContext: BuildExpressionContext): Expression {
        if (this.aggregateFunction === AggregateFunction.Count && this._parent == undefined)
            return new PropertyExpression(elements, "length");

        const body = this._parent!.buildExpression(groupContext);
        const lambda = new LambdaExpression([groupContext.parameter], body);
        const method =
            this.aggregateFunction === AggregateFunction.Sum ? "sum" :
            this.aggregateFunction === AggregateFunction.Min ? "min" :
            this.aggregateFunction === AggregateFunction.Max ? "max" :
            this.aggregateFunction === AggregateFunction.Average ? "average" :
            "count"; // Count with a parent → count of matching rows
        return new CallExpression(new PropertyExpression(elements, method), [lambda], this.type);
    }
}
