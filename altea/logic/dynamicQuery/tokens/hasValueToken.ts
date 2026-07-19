import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, ArrayType, LiteralType } from "../../../entities/runtimeTypes";
import { Expression, BinaryExpression, ConstantExpression, PropertyExpression, CallExpression } from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions } from "./queryToken";

// Port of Signum's `HasValueToken`: a trailing boolean "[Has value]" sub-token appended to most
// value/reference lists. For a collection it is `col.some()`; otherwise `value != null` (and, for a
// string, also `!= ""`).
export class HasValueToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
        this.priority = -1;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "HasValue"; }
    override toString(): string { return "[Has value]"; }
    niceName(): string { return `Has value of ${this._parent.toString()}`; }
    get type(): RuntimeType { return LiteralType.boolean; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        const base = this._parent.buildExpression(context);

        if (this._parent.type instanceof ArrayType)
            return new CallExpression(new PropertyExpression(base, "some"), [], LiteralType.boolean);

        const notNull = new BinaryExpression("!=", base, new ConstantExpression(null));
        if (this._parent.type === LiteralType.string)
            return new BinaryExpression("&&", notNull, new BinaryExpression("!=", base, new ConstantExpression("")));
        return notNull;
    }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
