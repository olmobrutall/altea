import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { RuntimeType, LiteralType } from "../../runtimeTypes";
import { QueryToken, SubTokensOptions } from "./queryToken";

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

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(LiteralType.string, options, undefined);
    }
}
