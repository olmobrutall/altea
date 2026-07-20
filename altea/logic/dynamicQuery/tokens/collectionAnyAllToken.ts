import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import { RuntimeType, ClassType, LiteType, ArrayType, LiteralType } from "../../../entities/runtimeTypes";
import {
    Expression, ParameterExpression, LambdaExpression, CallExpression, PropertyExpression, UnaryExpression,
} from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions, entityCtorOf } from "./queryToken";

// Signum's CollectionAnyAllType (DynamicQuery/Tokens/CollectionAnyAllToken.cs).
export enum CollectionAnyAllType {
    Any = "Any",
    All = "All",
    NotAny = "NotAny",
    NotAll = "NotAll",
}

// Port of Signum's `CollectionAnyAllToken`: a quantifier over a collection (`.Any`/`.All`/…). Like
// CollectionElementToken its own BuildExpression throws — but a filter GROUP whose token passes
// through it (`FilterGroup`) drives `buildAnyAll`, which produces the correlated `some`/`every`
// subquery. This is what lets `a.friends.some(f => f.name == "john" && a.age == 20)` be expressed:
// the group binds the element parameter, so inner conditions on the element AND on the outer row
// combine inside one quantifier.
export class CollectionAnyAllToken extends QueryToken {
    private readonly elementType: RuntimeType;

    constructor(private readonly _parent: QueryToken, public readonly anyAllType: CollectionAnyAllType) {
        super();
        const et = _parent.type.elementType;
        if (et == undefined)
            throw new Error(`${_parent.fullKey()} is not a collection`);
        this.elementType = et;
    }

    override isCollectionToken(): boolean { return true; }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.anyAllType; }
    override toString(): string { return this.anyAllType; }
    niceName(): string { return `${this.anyAllType} of ${this._parent.toString()}`; }

    get type(): RuntimeType {
        if (this.elementType instanceof ClassType && entityCtorOf(this.elementType) != undefined)
            return new LiteType(this.elementType);
        return this.elementType;
    }

    get format(): string | undefined { return this._parent.format; }
    get unit(): string | undefined { return this._parent.unit; }
    getImplementations(): Implementations | undefined { return this._parent.getElementImplementations(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    getPropertyRoute(): PropertyRoute | undefined {
        const pr = this._parent.getPropertyRoute();
        if (pr != undefined && pr.type instanceof ArrayType)
            return pr.add("Item");
        return pr;
    }

    // The element parameter type (so a FilterGroup can create the quantifier parameter).
    createParameter(): ParameterExpression {
        const name = "_" + (this.elementType instanceof ClassType ? this.elementType.constructorFunction.name[0].toLowerCase() : "e");
        return new ParameterExpression(name, this.elementType);
    }

    protected buildExpressionInternal(_context: BuildExpressionContext): Expression {
        throw new Error("CollectionAnyAllToken should have a replacement at this stage (used inside a FilterGroup)");
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }

    // Port of Signum's BuildAnyAll: wrap the group's `body` in the quantifier over `collection`,
    //   Any    → collection.some(param => body)
    //   All    → collection.every(param => body)
    //   NotAny → !collection.some(param => body)
    //   NotAll → collection.some(param => !body)
    buildAnyAll(collection: Expression, param: ParameterExpression, body: Expression): Expression {
        let b = body;
        if (this.anyAllType === CollectionAnyAllType.NotAll)
            b = new UnaryExpression("!", b);

        const lambda = new LambdaExpression([param], b);
        const method = this.anyAllType === CollectionAnyAllType.All ? "every" : "some";
        let result: Expression = new CallExpression(new PropertyExpression(collection, method), [lambda], LiteralType.boolean);

        if (this.anyAllType === CollectionAnyAllType.NotAny)
            result = new UnaryExpression("!", result);

        return result;
    }
}
