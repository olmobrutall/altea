import { PropertyRoute, usingLegacyPropertyPaths } from "../../propertyRoute";
import { QueryTokenMessage } from "../../dynamicQueries";
import { Implementations } from "../../implementations";
import { cleanTypeName } from "../../registration";
import type { Type, Entity } from "../../entity";
import { TypeReference } from "../../reflection";
import { QueryToken, SubTokensOptions } from "./queryToken";

// Port of Signum's `AsTypeToken`: casts a polymorphic (@implementedBy) reference to one concrete
// implementation, so its members become navigable — `author.(Artist).name`. Key is "(CleanName)".
export class AsTypeToken extends QueryToken {
    constructor(
        private readonly _parent: QueryToken,
        // A concrete entity type, so `entityCtor.niceName()` (the Type<T> static, inherited) reads its
        // localized display name directly — no niceName(ctor) call.
        public readonly entityCtor: Type<Entity>,
    ) {
        super();
        this.priority = 8;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return `(${cleanTypeName(this.entityCtor)})`; }
    override toString(): string { return QueryTokenMessage.As0.niceToString(this.entityCtor.niceName()); }
    niceName(): string { return QueryTokenMessage._0As1.niceToString(this._parent.toString(), this.entityCtor.niceName()); }
    get type(): TypeReference { return new TypeReference({ type: () => this.entityCtor, lite: true }); }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return Implementations.by(this.entityCtor); }
    /**
     * The REAL cast route where the parent token has one — `PropertyRoute.addCast`, which re-roots at a
     * non-part exactly as this used to and continues the owner's route into a `@part`. So the token layer
     * and the route layer now agree on what a cast is, and a part CONTENT's members are addressable from
     * both (`(Dashboard).parts/content.(TextPart).textContent`).
     *
     * `rootStandalone` remains the fallback, and it is still reached: by a token whose parent has no
     * route (an `@implementedByAll` reached from an expression, a manual query's column), and in LEGACY
     * mode, where `generateRoutes` suppresses casts so no such route is in the model set. It keeps the
     * token working rather than making a model choice into a crash — which was always its job here.
     */
    getPropertyRoute(): PropertyRoute | undefined {
        // Legacy mode generates no cast route (see PropertyRoute.generateRoutes), so building one here
        // would hand back a route the model does not contain — and every consumer of a token's route
        // looks it up in that set. Fall back to what the mode does have.
        const parentRoute = usingLegacyPropertyPaths() ? undefined : this._parent.getPropertyRoute();
        if (parentRoute != undefined) {
            try {
                return parentRoute.addCast(this.entityCtor);
            } catch {
                // A cast the ROUTE model cannot express — the parent route is not an entity reference, or
                // the implementations do not admit this type. The token is still valid (it came from the
                // token layer's own implementations), so fall back rather than fail.
            }
        }
        return PropertyRoute.rootStandalone(this.entityCtor);
    }
    isAllowed(): string | null { return this._parent.isAllowed() ?? this.getPropertyRoute()!.isAllowed(); }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
