import { PropertyRoute, isPartType } from "../../propertyRoute";
import { FieldInfo, TypeReference, tryGetTypeInfo, defaultFormat } from "../../reflection";
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
        public readonly route: PropertyRoute | undefined,
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
        // The synthetic `Id` token's route. For an ordinary entity it is that entity's own root — the
        // token re-rooted there, as `PropertyRoute.add` does. A `@part` does NOT re-root (it is a
        // continuation of its owner), and it may not be a route root at all, so the id token borrows the
        // PARENT's route: `isAllowed` then answers the collection's rule, which is the one that governs
        // the row. Undefined when the parent has none, exactly as the other synthetic tokens
        // (ToString / HasValue / Count) carry none.
        const route = isPartType(ctor) ? parent.getPropertyRoute() : PropertyRoute.root(ctor);
        const t = new EntityPropertyToken(parent, fi, route, true);
        t.priority = 10;
        return t;
    }

    get parent(): QueryToken | undefined { return this._parent; }

    // Signum's `Key => PropertyInfo.Name` — PascalCase, because a C# property is. altea's field is
    // camelCase and the key used to be it verbatim, which put the whole workspace at odds with itself:
    // `QueryTokenString.tokenSequence` (what `Type.token(a => a.shipName)` and every `defaultColumns`
    // entry go through) has always PascalCased, so a token BUILT by the typed builder could only be
    // resolved by the client's case-insensitive cache and never by the server's exact lookup — which is
    // why altea-workflow's Inbox had to spell its tokens as camelCase literals. One spelling now, and it
    // is Signum's, so a stored token is the same string in both frameworks.
    get key(): string { return this.fieldInfo.name.firstUpper(); }

    // The row-identity column of a ModelEntity query: its top-level `entity` field (Signum's "Entity"
    // column). Flagged so ResultTable splits it out as the row's navigable entity (the row link).
    override isEntity(): boolean {
        return this.fieldInfo.name === "entity" && this._parent.parent == undefined;
    }

    // altea divergence: this token navigates a @backReference field (the child-side FK back to its owner).
    // Drives `dimAsBackNavigation` — the token-tree picker greys it when reached under a collection operator.
    override isBackReferenceToken(): boolean { return this.fieldInfo.isBackReference === true; }

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
        const t = this.route!.type;
        // A reference field projects as Lite<T> (Signum's BuildLite): the same TypeReference marked lite.
        // NOTE: `t` may be the live FieldInfo (PropertyRoute.type returns it directly) — always copy, never
        // mutate it, so the nullify does not corrupt the shared field metadata.
        if (entityCtorOf(t) != undefined)
            return Object.assign(new TypeReference(), t, { lite: true, isNullable: true });
        return Object.assign(new TypeReference(), t, { isNullable: true });
    }

    // Signum's Reflector.GetFormatString: the Id (a primary-key int) formats as "D" — decimal, NO
    // thousands grouping (so "10248", not "10,248"); other fields use their own @format.
    get format(): string | undefined { return this.isId ? (this.fieldInfo.typeName === "Guid" ? undefined : "D") : (this.fieldInfo?.format ?? defaultFormat(this.fieldInfo)); }
    // Signum's EntityPropertyToken.Unit: the field's [Unit] (altea's @unit, stored on FieldInfo). The
    // synthetic id token has no unit.
    get unit(): string | undefined { return this.isId ? undefined : this.fieldInfo?.unit; }

    getImplementations(): Implementations | undefined {
        return this.isId ? undefined : this.route!.tryGetImplementations();
    }

    getPropertyRoute(): PropertyRoute | undefined { return this.route; }

    isAllowed(): string | null {
        return this._parent.isAllowed() ?? (this.route?.isAllowed() ?? null);
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
