import { PropertyRoute } from "../../propertyRoute";
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
    override toString(): string { return `As ${this.entityCtor.niceName()}`; }
    niceName(): string { return `${this._parent.toString()} as ${this.entityCtor.niceName()}`; }
    get type(): TypeReference { return new TypeReference({ type: () => this.entityCtor, lite: true }); }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return Implementations.by(this.entityCtor); }
    getPropertyRoute(): PropertyRoute | undefined { return PropertyRoute.root(this.entityCtor); }
    isAllowed(): string | null { return this._parent.isAllowed() ?? this.getPropertyRoute()!.isAllowed(); }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
