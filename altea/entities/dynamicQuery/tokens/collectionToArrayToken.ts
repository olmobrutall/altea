import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { type RuntimeType, ClassType, LiteType, ArrayType } from "../../runtimeTypes";
import { QueryToken, SubTokensOptions, entityCtorOf } from "./queryToken";

// Signum's `CollectionToArrayType` (DynamicQuery/Tokens/CollectionToArrayToken.cs): aggregate a
// collection's navigated values into a single delimited STRING (SQL STRING_AGG), optionally DISTINCT.
export enum CollectionToArrayType {
    SeparatedByComma = "SeparatedByComma",
    SeparatedByCommaDistinct = "SeparatedByCommaDistinct",
    SeparatedByNewLine = "SeparatedByNewLine",
    SeparatedByNewLineDistinct = "SeparatedByNewLineDistinct",
}

export function toArraySeparator(t: CollectionToArrayType): string {
    return t === CollectionToArrayType.SeparatedByNewLine || t === CollectionToArrayType.SeparatedByNewLineDistinct ? "\n" : ", ";
}
export function toArrayDistinct(t: CollectionToArrayType): boolean {
    return t === CollectionToArrayType.SeparatedByCommaDistinct || t === CollectionToArrayType.SeparatedByNewLineDistinct;
}

// Port of Signum's `CollectionToArrayToken`: a sub-token on a collection that COLLAPSES it into one
// string cell (unlike CollectionElementToken, which multiplies rows). It exposes the element's
// sub-tokens for navigation (`songs.SeparatedByComma.name`), but its value is the navigated leaf
// aggregated with STRING_AGG. Its own BuildExpression THROWS — the DQueryable select layer detects a
// token with a CollectionToArray ancestor (`hasToArray()`) and builds
// `collection.map(e => leaf)[.distinct()].join(separator)`. (Signum's MList RowId/RowOrder branch is
// intentionally not ported — altea models MList as part-entities.)
export class CollectionToArrayToken extends QueryToken {
    private readonly elementType: RuntimeType;

    constructor(private readonly _parent: QueryToken, public readonly toArrayType: CollectionToArrayType) {
        super();
        const et = _parent.type.elementType;
        if (et == undefined)
            throw new Error(`${_parent.fullKey()} is not a collection`);
        this.elementType = et;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.toArrayType; }
    override toString(): string { return this.toArrayType; }
    niceName(): string { return `${this.toArrayType} of ${this._parent.toString()}`; }

    // Navigation uses the element type; a reference element navigates as a Lite.
    get type(): RuntimeType {
        if (this.elementType instanceof ClassType && entityCtorOf(this.elementType) != undefined)
            return new LiteType(this.elementType);
        return this.elementType;
    }

    get format(): string | undefined { return this._parent.format; }
    get unit(): string | undefined { return this._parent.unit; }
    getImplementations(): Implementations | undefined { return this._parent.getElementImplementations(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    getPropertyRoute(): PropertyRoute | undefined {
        const pr = this._parent.getPropertyRoute();
        if (pr != undefined && pr.type instanceof ArrayType)
            return pr.add("Item");
        return pr;
    }

    override hasToArray(): CollectionToArrayToken | undefined { return this; }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
