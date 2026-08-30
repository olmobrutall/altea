import { PropertyRoute } from "../../propertyRoute";
import { Implementations } from "../../implementations";
import { Entity, type BaseEntity, type Type } from "../../entity";
import { TypeReference } from "../../reflection";
import type { QueryName } from "../queryUtils";
import { QueryToken, SubTokensOptions, SubTokensOptionsAll } from "./queryToken";

// The root token of a query (Signum's "Entity" ColumnToken, renamed since altea has no other column
// tokens). altea's redesign: a query's shape is a reflected entity/model type, so this token IS that
// type — it's the entry point for all navigation. Its key is "" — the rootless
// convention, so navigations read "Name", "Customer.Name" (not "Entity.Name"); its expression is the
// row parameter itself; its sub-tokens are the shape type's properties. There are no other "column"
// tokens (computed columns are registered expressions; the client picks display columns as token
// paths), so RootToken is now purely the query root.
export class RootToken extends QueryToken {
    // The query's shape type (a reflected entity/model constructor), so `shapeType.niceName()` reads its
    // localized display name directly. It used to be declared `Function` and cast, because the query
    // infra around it was Function-typed; `getRootType()` and `QueryName` are both `Type<BaseEntity>`
    // now, so nothing widens and nothing casts.
    constructor(
        private readonly shapeType: Type<BaseEntity>,
        private readonly _queryName: QueryName = shapeType,
    ) {
        super();
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

/**
 * The token carrying a row's ENTITY — Signum's "Entity" column — or undefined when the row has none.
 *
 * Two shapes, one answer. A full-entity query's row IS the entity, so the root token is it. A query
 * named by a row MODEL has no identity of its own and carries one in an `entity` member, which is the
 * convention every row model in the workspace follows (`CustomerModel`, `InboxRowModel`,
 * `ActiveDirectoryUserModel`) and is Signum's Entity column by another name.
 *
 * Everything that makes a row navigable reads this: the query core adds it as a column, ResultTable
 * splits it out of the DISPLAY columns into `entityColumn` (so it is fetched but never shown — the
 * "hidden column" a model query would otherwise need configured by hand), and the SearchControl reads
 * `row.entity` for its link, its double-click and its selection.
 */
export function rowEntityToken(root: QueryToken): QueryToken | undefined {
    if (root.type.is(Entity))
        return root;
    const member = root.subToken("entity", SubTokensOptionsAll);
    return member?.isEntity() === true ? member : undefined;
}
