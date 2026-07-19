import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, ClassType, LiteType, ArrayType } from "../../../entities/runtimeTypes";
import type { Expression } from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions, entityCtorOf } from "./queryToken";

// Signum's CollectionElementType (DynamicQuery/Tokens/CollectionElementToken.cs).
export enum CollectionElementType {
    Element = "Element",
    Element2 = "Element2",
    Element3 = "Element3",
}

// Port of Signum's `CollectionElementToken`: navigates into the elements of a collection. Its own
// BuildExpression THROWS — it is not self-contained. The query-expansion layer
// (logic/dynamicQuery/queryExpansion.ts, Signum's DQueryable.SelectMany) rewrites the source query
// with a flatMap over the collection and SEEDS this token's expression in the
// BuildExpressionContext.replacements before any navigation is built.
export class CollectionElementToken extends QueryToken {
    private readonly elementType: RuntimeType;

    constructor(private readonly _parent: QueryToken, public readonly collectionElementType: CollectionElementType) {
        super();
        const et = _parent.type.elementType;
        if (et == undefined)
            throw new Error(`${_parent.fullKey()} is not a collection`);
        this.elementType = et;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.collectionElementType; }
    override toString(): string { return this.collectionElementType; }
    niceName(): string { return `${this.collectionElementType} of ${this._parent.toString()}`; }

    // A reference element projects as a Lite (Signum's BuildLiteNullifyUnwrapPrimaryKey).
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

    protected buildExpressionInternal(_context: BuildExpressionContext): Expression {
        throw new Error("CollectionElementToken should have a replacement at this stage (expand collections first — see queryExpansion.ts)");
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        // TODO(phase3d+): MListElementPropertyToken (RowId / RowOrder) alongside the element's own tokens.
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
