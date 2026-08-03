import { PropertyRoute } from "../../propertyRoute";
import { FieldInfo, TypeReference } from "../../reflection";
import type { Implementations } from "../../implementations";
import { QueryToken, SubTokensOptions, entityCtorOf, TR_INT } from "./queryToken";

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
        fi.typeName = "Number";
        fi.subTypeName = "int";
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

    // Signum's Type: a reference field projects as `Lite<T>` (BuildLite), a primary key unwraps to
    // its scalar. Value / already-lite / embedded fields keep the field's own type.
    get type(): TypeReference {
        if (this.isId)
            return TR_INT;
        const t = this.route.type;
        // A reference field projects as Lite<T> (Signum's BuildLite): the same TypeReference marked lite.
        if (entityCtorOf(t) != undefined)
            return Object.assign(new TypeReference(), t, { lite: true });
        return t;
    }

    // Signum's Reflector.GetFormatString: the Id (a primary-key int) formats as "D" — decimal, NO
    // thousands grouping (so "10248", not "10,248"); other fields use their own @format.
    get format(): string | undefined { return this.isId ? "D" : this.fieldInfo?.format; }
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
