import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { TypeReference } from "../../reflection";
import { QueryToken, SubTokensOptions, entityCtorOf } from "./queryToken";

// Signum's CollectionAnyAllType (DynamicQuery/Tokens/CollectionAnyAllToken.cs).
export enum CollectionAnyAllType {
    Any = "Any",
    All = "All",
    NotAny = "NotAny",
    NotAll = "NotAll",
}

// Port of Signum's `CollectionAnyAllToken`: a quantifier over a collection (`.Any`/`.All`/…). Like
// CollectionElementToken its own BuildExpression throws — but a filter GROUP whose token passes
// through it (`FilterGroup`) drives `buildAnyAll`, which produces the correlated `some`/`every`
// subquery. This is what lets `a.friends.some(f => f.name == "john" && a.age == 20)` be expressed:
// the group binds the element parameter, so inner conditions on the element AND on the outer row
// combine inside one quantifier.
export class CollectionAnyAllToken extends QueryToken {
    readonly elementType: TypeReference;

    constructor(private readonly _parent: QueryToken, public readonly anyAllType: CollectionAnyAllType) {
        super();
        const et = _parent.type.elementType;
        if (et == undefined)
            throw new Error(`${_parent.fullKey()} is not a collection`);
        this.elementType = et;
    }

    override isCollectionToken(): boolean { return true; }
    override isAnyOrAll(): boolean { return true; }

    // A quantifier is a leaf navigation aid, never auto-expanded, and hidden from a flattened list.
    protected override get autoExpandInternal(): boolean { return false; }
    override get hideInAutoExpand(): boolean { return true; }
    override hasAny(): boolean { return this.anyAllType == CollectionAnyAllType.Any || super.hasAny(); }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.anyAllType; }
    override toString(): string { return this.anyAllType; }
    niceName(): string { return `${this.anyAllType} of ${this._parent.toString()}`; }

    get type(): TypeReference {
        return entityCtorOf(this.elementType) != undefined
            ? Object.assign(new TypeReference(), this.elementType, { lite: true })
            : this.elementType;
    }

    get format(): string | undefined { return this._parent.format; }
    get unit(): string | undefined { return this._parent.unit; }
    getImplementations(): Implementations | undefined { return this._parent.getElementImplementations(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    getPropertyRoute(): PropertyRoute | undefined {
        const pr = this._parent.getPropertyRoute();
        if (pr != undefined && pr.type.array)
            return pr.add("Item");
        return pr;
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
