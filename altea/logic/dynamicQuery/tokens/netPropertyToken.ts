import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import type { RuntimeType } from "../../../entities/runtimeTypes";
import { Expression, PropertyExpression, CallExpression } from "../../linq/expressions";
import { QueryToken, BuildExpressionContext, SubTokensOptions } from "./queryToken";

// Port of Signum's `NetPropertyToken`: a ".NET member" sub-token — a property or parameterless
// method on a value type (String.Length, DateTime.Year, DateTime.Quarter(), …). The generators on
// QueryToken (stringTokens, and Phase-3b DateTimeProperties/StepTokens) build these. `memberName`
// is the altea member the binder understands (lowercase: "length", "year", "quarter", …).
export class NetPropertyToken extends QueryToken {
    constructor(
        private readonly _parent: QueryToken,
        public readonly memberName: string,
        private readonly resultType: RuntimeType,
        private readonly displayName: string,
        private readonly isMethod: boolean,
        private readonly _format?: string,
        private readonly _unit?: string,
    ) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.memberName; }
    override toString(): string { return this.displayName; }
    niceName(): string { return `${this.displayName} of ${this._parent.toString()}`; }
    get type(): RuntimeType { return this.resultType; }
    get format(): string | undefined { return this._format; }
    get unit(): string | undefined { return this._unit; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        const base = this._parent.buildExpression(context);
        const member = new PropertyExpression(base, this.memberName);
        return this.isMethod ? new CallExpression(member, [], this.resultType) : member;
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, undefined);
    }
}
