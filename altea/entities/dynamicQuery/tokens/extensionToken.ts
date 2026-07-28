import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import type { RuntimeType } from "../../runtimeTypes";
import { QueryToken, SubTokensOptions } from "./queryToken";

// The client-relevant metadata of an ExtensionToken (Signum's ExtensionInfo, reduced to what the
// token needs to display itself and generate its sub-tokens). This is the SERIALIZABLE form: it is
// what the client receives (via the cached-ajax extension-token source) and rebuilds tokens from.
//
// The un-serializable server-only bits (the quoted `lambda` and its provenance `Meta`) live behind
// the opaque `serverInfo` handle — set only when the SERVER creates the token (so it can build the
// SQL expression); undefined on client-reconstructed tokens, which never build expressions.
export interface ExtensionInfo {
    readonly key: string;
    // Display name (Signum's culture-dependent Func<string>) — a THUNK so it stays lazy: the server
    // wires the live niceName, the JSON codec resolves it to a value and the client rebuilds a
    // constant thunk from that value.
    readonly niceName: () => string;
    readonly resultType: RuntimeType;
    readonly isProjection: boolean;
    readonly implementations?: Implementations;
    // From the expression's Meta on the server: a clean single-route expression exposes that route
    // (Signum's ExtensionToken over CleanMeta); a computed/multi-route one has none.
    readonly propertyRoute?: PropertyRoute;
    // Auth reason from the expression's source columns (Signum's Meta.IsAllowed) — a THUNK so it
    // re-reads the live auth context each call; null ⇒ allowed. Combined with the parent in isAllowed().
    readonly allowedReason?: () => string | null;
    // OPAQUE server handle ({ lambda, meta, sourceType }) needed only to BUILD the SQL expression
    // server-side; installed by ExpressionContainer.getExtensionsTokens. NOT part of the JSON form
    // (a client-reconstructed token leaves it undefined and never builds an expression).
    readonly serverInfo?: unknown;
}

// Port of Signum's `ExtensionToken`: a sub-token backed by a registered cross-entity expression
// (`QueryLogic.Expressions.Register`), e.g. `Customer.Orders` → a nested query. A projection
// (collection result) exposes the element's own sub-tokens; the implementations live on the element.
//
// The MODEL lives here in entities so both server and client can navigate/display extension tokens;
// its `buildExpressionInternal` (server-only) is attached in logic/dynamicQuery/tokenExpressions.
// Which extension tokens exist for a parent is the divergent EXTENSION POINT (setExtensionTokensProvider):
// server reads the local registration table (ExpressionContainer), client a cached ajax request.
export class ExtensionToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly info: ExtensionInfo) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.info.key; }
    override toString(): string { return this.info.niceName(); }
    niceName(): string { return this.info.niceName(); }
    get type(): RuntimeType { return this.info.resultType; }
    // unit/format aren't modelled on altea fields yet; once they are they come from the token's
    // single clean route (Signum's CleanMeta.PropertyRoutes → Format/Unit).
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }

    // Allowed only if BOTH the parent chain and the expression's source columns are (Signum's token
    // IsAllowed + Meta.IsAllowed). Reasons combine; null ⇒ allowed.
    isAllowed(): string | null {
        const reasons = [this._parent.isAllowed(), this.info.allowedReason?.() ?? null].filter((x): x is string => x != null);
        return reasons.length === 0 ? null : reasons.join(", ");
    }

    getPropertyRoute(): PropertyRoute | undefined { return this.info.propertyRoute; }

    getImplementations(): Implementations | undefined {
        return this.info.isProjection ? undefined : this.info.implementations;
    }
    override getElementImplementations(): Implementations | undefined {
        return this.info.isProjection ? this.info.implementations : undefined;
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations() ?? this.getElementImplementations());
    }
}
