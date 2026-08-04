import { PropertyRoute } from "../../propertyRoute";
import { Implementations } from "../../implementations";
import { Entity, type BaseEntity, type Type } from "../../entity";
import { TypeReference } from "../../reflection";
import type { QueryName } from "../queryUtils";
import { QueryToken, SubTokensOptions } from "./queryToken";

// The root token of a query (Signum's "Entity" ColumnToken, renamed since altea has no other column
// tokens). altea's redesign: a query's shape is a reflected entity/model type, so this token IS that
// type — it's the entry point for all navigation. Its key is "" — the rootless
// convention, so navigations read "Name", "Customer.Name" (not "Entity.Name"); its expression is the
// row parameter itself; its sub-tokens are the shape type's properties. There are no other "column"
// tokens (computed columns are registered expressions; the client picks display columns as token
// paths), so RootToken is now purely the query root.
export class RootToken extends QueryToken {
    // The query's shape type (a reflected entity/model constructor), typed as Type<BaseEntity> so
    // `shapeType.niceName()` reads its localized display name directly. The constructor accepts a bare
    // Function — the surrounding query infra is Function-typed (getRootType(): Function) — and narrows
    // here; the value is always an entity/model ctor.
    private readonly shapeType: Type<BaseEntity>;

    constructor(
        shapeType: Function,
        private readonly _queryName: QueryName = shapeType,
    ) {
        super();
        this.shapeType = shapeType as Type<BaseEntity>;
    }

    get parent(): QueryToken | undefined { return undefined; }
    override get queryName(): QueryName { return this._queryName; }
    override isEntity(): boolean { return true; }

    get key(): string { return ""; }
    override toString(): string { return this.shapeType.niceName(); }
    niceName(): string { return this.shapeType.niceName(); }

    get type(): TypeReference { return new TypeReference({ type: () => this.shapeType }); }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }

    // Only a full-entity shape has entity implementations; a ModelEntity projection row does not
    // (its `entity` FIELD carries the row identity instead).
    getImplementations(): Implementations | undefined {
        const isEntity = (this.shapeType as Function) === Entity || this.shapeType.prototype instanceof Entity;
        return isEntity ? Implementations.by(this.shapeType) : undefined;
    }
    getPropertyRoute(): PropertyRoute | undefined { return PropertyRoute.root(this.shapeType); }
    isAllowed(): string | null { return null; }

    // Signum's ColumnToken.AutoExpandInternal => Column.IsEntity: the query root auto-expands so its
    // members are reachable inline (and it anchors the recursion guard for same-typed descendants).
    protected override get autoExpandInternal(): boolean { return this.isEntity() || super.autoExpandInternal; }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
