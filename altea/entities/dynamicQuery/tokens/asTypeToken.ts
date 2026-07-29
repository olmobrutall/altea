import { PropertyRoute } from "../../propertyRoute";
import { Implementations } from "../../implementations";
import { cleanTypeName } from "../../registration";
import { niceName } from "../../utils/localization";
import { TypeReference } from "../../reflection";
import { QueryToken, SubTokensOptions } from "./queryToken";

// Port of Signum's `AsTypeToken`: casts a polymorphic (@implementedBy) reference to one concrete
// implementation, so its members become navigable — `author.(Artist).name`. Key is "(CleanName)".
export class AsTypeToken extends QueryToken {
    constructor(
        private readonly _parent: QueryToken,
        public readonly entityCtor: Function,
    ) {
        super();
        this.priority = 8;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return `(${cleanTypeName(this.entityCtor)})`; }
    override toString(): string { return `As ${niceName(this.entityCtor)}`; }
    niceName(): string { return `${this._parent.toString()} as ${niceName(this.entityCtor)}`; }
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
