import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, LiteralType } from "../../../entities/runtimeTypes";
import { Expression, PropertyExpression, CallExpression } from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions } from "./queryToken";

// Port of Signum's `CountToken`: the element count of a collection — `col.count()` (a correlated
// scalar subquery). Self-contained (no expansion needed): the parent collection token builds the
// array expression directly.
export class CountToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "Count"; }
    override toString(): string { return "Count"; }
    niceName(): string { return `Count of ${this._parent.toString()}`; }
    get type(): RuntimeType { return LiteralType.number; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        const collection = this._parent.buildExpression(context);
        return new CallExpression(new PropertyExpression(collection, "count"), [], LiteralType.number);
    }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
