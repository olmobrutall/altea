import { PropertyRoute } from "../../propertyRoute";
import { FieldInfo, TypeReference, tryGetTypeInfo } from "../../reflection";
import type { Implementations } from "../../implementations";
import { QueryToken, SubTokensOptions, entityCtorOf } from "./queryToken";

// Port of Signum's `EntityPropertyToken` (DynamicQuery/Tokens/EntityPropertyToken.cs): navigation
// into a field/property of an entity or embedded. `isId` marks the synthetic `Entity.Id` token
// (altea's `id` lives on the Entity base and is not @field-injected, so it can't be a PropertyRoute
// step — it is special-cased here, matching Signum's `IdProperty`).
export class EntityPropertyToken extends QueryToken {
    constructor(
        private readonly _parent: QueryToken,
        public readonly fieldInfo: FieldInfo,
        public readonly route: PropertyRoute,
        public readonly isId = false,
    ) {
        super();
    }

    static idProperty(parent: QueryToken): QueryToken {
        const ctor = entityCtorOf(parent.type);
        if (ctor == undefined)
            throw new Error(`IdProperty on a non-entity token ${parent.fullKey()}`);
        const fi = new FieldInfo("id");
        // Reflect the entity's actual primary-key type (@primaryKey): a GUID key shows as "Guid"
        // (truncated cell + guid filter editor), an int/long key as "Number". Signum keyed EntityId's
        // type off PrimaryKeyAttribute the same way.
        const pkType = tryGetTypeInfo(ctor)?.fields["id"]?.columnOptions?.primaryKey;
        if (pkType === "uuid" || pkType === "uuid7") {
            fi.typeName = "Guid";
        } else {
            fi.typeName = "Number";
            fi.subTypeName = "int";
        }
        const t = new EntityPropertyToken(parent, fi, PropertyRoute.root(ctor), true);
        t.priority = 10;
        return t;
    }

    get parent(): QueryToken | undefined { return this._parent; }

    get key(): string { return this.fieldInfo.name; }

    // The row-identity column of a ModelEntity query: its top-level `entity` field (Signum's "Entity"
    // column). Flagged so ResultTable splits it out as the row's navigable entity (the row link).
    override isEntity(): boolean {
        return this.fieldInfo.name === "entity" && this._parent.parent == undefined;
    }

    override toString(): string { return this.fieldInfo.niceToString(); }
    niceName(): string { return this.fieldInfo.niceToString(); }

    // Signum's Type: `PropertyInfo.PropertyType.BuildLiteNullifyUnwrapPrimaryKey`: a reference field
    // projects as `Lite<T>` (BuildLite), a primary key unwraps to its scalar, and — for ALL branches —
    // the result is NULLIFIED. A query column is always potentially null (joins / OUTER APPLY project
    // the row's absence), so `isNullable` must be set: without it, a filter value editor on a required
    // column (e.g. the `Customer` FK) would be treated as mandatory and `defaultResetValidationError`
    // would call `ctx.niceName()` — which throws, since a filter value ctx has no propertyRoute.
    get type(): TypeReference {
        if (this.isId)
            // The synthetic id token's facets live on its FieldInfo (typeName set by idProperty from the
            // entity's @primaryKey). A plain int key is still TR_INT; a GUID key surfaces as "Guid".
            return this.fieldInfo.typeName === "Guid"
                ? new TypeReference({ typeName: "Guid", isNullable: true })
                : new TypeReference({ typeName: "Number", subTypeName: "int", isNullable: true });
        const t = this.route.type;
        // A reference field projects as Lite<T> (Signum's BuildLite): the same TypeReference marked lite.
        // NOTE: `t` may be the live FieldInfo (PropertyRoute.type returns it directly) — always copy, never
        // mutate it, so the nullify does not corrupt the shared field metadata.
        if (entityCtorOf(t) != undefined)
            return Object.assign(new TypeReference(), t, { lite: true, isNullable: true });
        return Object.assign(new TypeReference(), t, { isNullable: true });
    }

    // Signum's Reflector.GetFormatString: the Id (a primary-key int) formats as "D" — decimal, NO
    // thousands grouping (so "10248", not "10,248"); other fields use their own @format.
    get format(): string | undefined { return this.isId ? (this.fieldInfo.typeName === "Guid" ? undefined : "D") : this.fieldInfo?.format; }
    get unit(): string | undefined { return undefined; }    // TODO(phase3): UnitAttribute

    getImplementations(): Implementations | undefined {
        return this.isId ? undefined : this.route.tryGetImplementations();
    }

    getPropertyRoute(): PropertyRoute | undefined { return this.route; }

    isAllowed(): string | null {
        return this._parent.isAllowed() ?? this.route.isAllowed();
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
