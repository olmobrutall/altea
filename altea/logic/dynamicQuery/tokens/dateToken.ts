import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, TemporalType } from "../../../entities/runtimeTypes";
import { Expression, PropertyExpression } from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions } from "./queryToken";

// Port of Signum's `DateToken`: the date (day-truncated) part of a date/time — `dt.date`
// (Signum's ToDateOnly). Groupable.
export class DateToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "Date"; }
    override toString(): string { return "Date"; }
    niceName(): string { return `Date of ${this._parent.toString()}`; }
    get type(): RuntimeType { return new TemporalType("date"); }
    get format(): string | undefined { return "d"; }
    get unit(): string | undefined { return undefined; }
    override get isGroupable(): boolean { return true; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        return new PropertyExpression(this._parent.buildExpression(context), "date");
    }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
