import type { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import type { RuntimeType } from "../../../entities/runtimeTypes";
import type { Expression } from "../../linq/expressions";
import { Meta, CleanMeta } from "../meta";
import { QueryToken, BuildExpressionContext, SubTokensOptions } from "./queryToken";

// The registered expression a token exposes (Signum's ExtensionInfo). `lambda` is the quoted
// `(source) => result`; `resultType` is the token's type (an ArrayType when `isProjection`).
export interface ExtensionInfo {
    readonly sourceType: Function;
    readonly key: string;
    readonly resultType: RuntimeType;
    readonly isProjection: boolean;
    readonly implementations?: Implementations;
    // A thunk (Signum's `Func<string>`): the display name is culture-dependent, so it is resolved
    // lazily each time rather than captured as a fixed string at registration.
    readonly niceName: () => string;
    readonly lambda: unknown; // Quoted<(source) => result>
    // Provenance of the registered expression (MetadataVisitor over the inlined body): which entity
    // routes it reads, so the token inherits IsAllowed (and, later, unit/format) from those columns.
    readonly meta: Meta;
}

// Set by expressionContainer.ts: inlines a registered expression's body against the parent
// expression (Signum's ExtensionToken.BuildExtension).
let buildExtensionExpr: ((info: ExtensionInfo, parentExpression: Expression) => Expression) | undefined;
export function setBuildExtensionExpr(fn: (info: ExtensionInfo, parentExpression: Expression) => Expression): void {
    buildExtensionExpr = fn;
}

// Port of Signum's `ExtensionToken`: a sub-token backed by a registered cross-entity expression
// (`QueryLogic.Expressions.Register`), e.g. `Customer.Orders` → a nested query. A projection
// (collection result) exposes the element's own sub-tokens; the implementations live on the element.
export class ExtensionToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly info: ExtensionInfo) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.info.key; }
    override toString(): string { return this.info.niceName(); }
    niceName(): string { return this.info.niceName(); }
    get type(): RuntimeType { return this.info.resultType; }
    // unit/format aren't modelled on altea fields yet; once they are they come from a single clean
    // route in info.meta (Signum's CleanMeta.PropertyRoutes → Format/Unit).
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }

    // Allowed only if BOTH the parent chain and the expression's source columns are (Signum's token
    // IsAllowed + Meta.IsAllowed). Reasons combine; null ⇒ allowed.
    isAllowed(): string | null {
        const reasons = [this._parent.isAllowed(), this.info.meta.isAllowed()].filter((x): x is string => x != null);
        return reasons.length === 0 ? null : reasons.join(", ");
    }

    // A clean single-route expression exposes that route (Signum's ExtensionToken over CleanMeta);
    // a computed/multi-route (DirtyMeta) expression has no single navigation route.
    getPropertyRoute(): PropertyRoute | undefined {
        const m = this.info.meta;
        return m instanceof CleanMeta && m.propertyRoutes.length === 1 ? m.propertyRoutes[0] : undefined;
    }

    getImplementations(): Implementations | undefined {
        return this.info.isProjection ? undefined : this.info.implementations;
    }
    override getElementImplementations(): Implementations | undefined {
        return this.info.isProjection ? this.info.implementations : undefined;
    }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        if (buildExtensionExpr == undefined)
            throw new Error("ExtensionToken build hook not set (import logic/dynamicQuery/expressionContainer)");
        return buildExtensionExpr(this.info, this._parent.buildExpression(context));
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations() ?? this.getElementImplementations());
    }
}
