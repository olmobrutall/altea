import { PropertyRoute } from "../../../entities/propertyRoute";
import { Implementations } from "../../../entities/implementations";
import { cleanTypeName } from "../../../entities/registration";
import { niceName } from "../../../entities/utils/localization";
import { RuntimeType, ClassType, LiteType } from "../../../entities/runtimeTypes";
import { Expression, CastExpression } from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions, extractEntity, buildLite } from "./queryToken";

// Port of Signum's `AsTypeToken`: casts a polymorphic (@implementedBy) reference to one concrete
// implementation, so its members become navigable — `author.(Artist).name`. Key is "(CleanName)".
export class AsTypeToken extends QueryToken {
    constructor(
        private readonly _parent: QueryToken,
        private readonly entityCtor: Function,
    ) {
        super();
        this.priority = 8;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return `(${cleanTypeName(this.entityCtor)})`; }
    override toString(): string { return `As ${niceName(this.entityCtor)}`; }
    niceName(): string { return `${this._parent.toString()} as ${niceName(this.entityCtor)}`; }
    get type(): RuntimeType { return new LiteType(new ClassType(this.entityCtor)); }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return Implementations.by(this.entityCtor); }
    getPropertyRoute(): PropertyRoute | undefined { return PropertyRoute.root(this.entityCtor); }
    isAllowed(): string | null { return this._parent.isAllowed() ?? this.getPropertyRoute()!.isAllowed(); }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        const base = this._parent.buildExpression(context);
        // (base.entity as EntityType), then project as a Lite.
        const cast = new CastExpression(extractEntity(base, false), new ClassType(this.entityCtor));
        return buildLite(cast);
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
