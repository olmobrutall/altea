import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, LiteralType } from "../../../entities/runtimeTypes";
import { Expression, PropertyExpression, CallExpression } from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions, extractEntity } from "./queryToken";

// Port of Signum's `EntityToStringToken`: the "[ToStr]" sub-token on an entity — its display string.
// `base.toString()` (the binder lowers it to the ToStr column or expands a @quoted toString).
export class EntityToStringToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
        this.priority = 9;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "ToString"; }
    override toString(): string { return "[ToStr]"; }
    niceName(): string { return `ToStr of ${this._parent.toString()}`; }
    get type(): RuntimeType { return LiteralType.string; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        const base = this._parent.buildExpression(context);
        // A lite/entity toString late-binds; a lite is dereferenced by extractEntity(true) = identity,
        // and the binder resolves .toString on either.
        return new CallExpression(new PropertyExpression(extractEntity(base, true), "toString"), [], LiteralType.string);
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(LiteralType.string, options, undefined);
    }
}
