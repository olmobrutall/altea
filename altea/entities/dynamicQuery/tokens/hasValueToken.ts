import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import type { TypeReference } from "../../reflection";
import { QueryToken, SubTokensOptions, TR_BOOLEAN } from "./queryToken";

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
    get type(): TypeReference { return TR_BOOLEAN; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
