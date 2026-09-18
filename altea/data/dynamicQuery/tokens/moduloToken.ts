import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import type { TypeReference } from "../../reflection";
import { QueryTokenMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions, TR_INT } from "./queryToken";

// Port of Signum's `ModuloToken`: `value % divisor` — a grouping bucket for integers.
export class ModuloToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly divisor: number) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    // The KEY stays the literal "Mod<n>" (it is stored in user assets); only the caption is localized.
    get key(): string { return "Mod" + this.divisor; }
    override toString(): string { return QueryTokenMessage.Modulo0.niceToString(this.divisor); }
    niceName(): string { return QueryTokenMessage._0Mod1.niceToString(this._parent.niceName(), this.divisor); }
    get type(): TypeReference { return TR_INT; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return this._parent.unit; }
    override get isGroupable(): boolean { return true; }
    getImplementations(): Implementations | undefined { return this._parent.getImplementations(); }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
