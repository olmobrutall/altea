import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, LiteralType } from "../../../entities/runtimeTypes";
import { Expression, BinaryExpression, ConstantExpression } from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions } from "./queryToken";

// Port of Signum's `ModuloToken`: `value % divisor` — a grouping bucket for integers.
export class ModuloToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly divisor: number) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "Mod" + this.divisor; }
    override toString(): string { return `Modulo ${this.divisor}`; }
    niceName(): string { return `${this._parent.toString()} mod ${this.divisor}`; }
    get type(): RuntimeType { return LiteralType.number; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return this._parent.unit; }
    override get isGroupable(): boolean { return true; }
    getImplementations(): Implementations | undefined { return this._parent.getImplementations(); }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        return new BinaryExpression("%", this._parent.buildExpression(context), new ConstantExpression(this.divisor));
    }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
