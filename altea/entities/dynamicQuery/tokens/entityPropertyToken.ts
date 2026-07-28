import { PropertyRoute } from "../../propertyRoute";
import { FieldInfo } from "../../reflection";
import type { Implementations } from "../../implementations";
import { RuntimeType, ClassType, LiteType, LiteralType } from "../../runtimeTypes";
import { QueryToken, SubTokensOptions, cleanType, entityCtorOf } from "./queryToken";

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
        const ctor = entityCtorOf(cleanType(parent.type));
        if (ctor == undefined)
            throw new Error(`IdProperty on a non-entity token ${parent.fullKey()}`);
        const fi = new FieldInfo("id");
        fi.typeName = "Number";
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
    get type(): RuntimeType {
        if (this.isId)
            return LiteralType.number;
        const t = this.route.type;
        if (t instanceof ClassType && entityCtorOf(t) != undefined)
            return new LiteType(t);
        return t;
    }

    get format(): string | undefined { return undefined; }  // TODO(phase3): Reflector.GetFormatString(route)
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
