import { PropertyRoute } from "../../../entities/propertyRoute";
import { FieldInfo } from "../../../entities/reflection";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, ClassType, LiteType, LiteralType } from "../../../entities/runtimeTypes";
import { Expression, PropertyExpression } from "../../linq/expressions";
import {
    QueryToken, BuildExpressionContext, SubTokensOptions,
    extractEntity, buildLite, cleanType, entityCtorOf,
} from "./queryToken";

// Port of Signum's `EntityPropertyToken` (DynamicQuery/Tokens/EntityPropertyToken.cs): navigation
// into a field/property of an entity or embedded. `isId` marks the synthetic `Entity.Id` token
// (altea's `id` lives on the Entity base and is not @field-injected, so it can't be a PropertyRoute
// step — it is special-cased here, matching Signum's `IdProperty`).
export class EntityPropertyToken extends QueryToken {
    constructor(
        private readonly _parent: QueryToken,
        public readonly fieldInfo: FieldInfo,
        public readonly route: PropertyRoute,
        private readonly isId = false,
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

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        const base = this._parent.buildExpression(context);

        if (this.isId)
            // Late-bound `.id` over a lite or an entity (Signum's ExtractEntity(true) + Id).
            return new PropertyExpression(extractEntity(base, true), "id");

        // TODO(phase3): mixin route step → wrap `entity.mixin(M)`; ToString property.
        const entity = extractEntity(base, false);
        const prop = new PropertyExpression(entity, this.fieldInfo.name);
        return buildLite(prop);
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
