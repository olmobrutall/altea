import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { TypeReference, defaultFormat } from "../../reflection";
import { QueryToken, SubTokensOptions } from "./queryToken";

// Port of Signum's IndexerContainerToken + ExtensionWithParameterToken (DynamicQuery/Tokens): a registered
// expression with a PARAMETER (`QueryLogic.expressions.registerWithParameter`), shown as a container token
// `[Skill]` whose children `[Skill].[Java]` are one per key the registration lists at runtime, each
// evaluating the expression with that key.
//
// The keys are dynamic (a cache, a table), which is what a static metadata blob cannot carry: the
// CONTAINER ships in the blob like any registered expression, and its children are listed by the server —
// synchronously there (the indexer-keys provider), through an endpoint on the client.
//
// A child's key is the parameter's toString(), as Signum's is: a stored column must mean the same thing in
// every environment the query is used in, and ids differ between them.

/** The serializable half of a registration with a parameter (Signum's ExtensionWithParameterInfo). */
export interface IndexerInfo {
    /** The container's key without brackets — `Skill` for `[Skill]`. */
    readonly prefix: string;
    readonly niceName: () => string;
    /** The expression's result type — what every child token is. */
    readonly resultType: TypeReference;
    readonly implementations?: Implementations;
    readonly propertyRoute?: PropertyRoute;
    readonly autoExpand: boolean;
    readonly allowedReason?: () => string | null;
    /** OPAQUE server registration; undefined on a client-reconstructed token. */
    readonly serverInfo?: unknown;
}

/** One child of a container: its key text, its caption, and (server only) the parameter value itself. */
export interface IndexerKey {
    readonly key: string;
    readonly niceName: string;
    readonly value?: unknown;
}

// The name-only type a container reports (Signum's `typeof(IndexerContainerToken)`): not filterable, not
// groupable — the container only groups its children.
export const TR_INDEXER_CONTAINER = new TypeReference({ typeName: "IndexerContainer" });

// The SERVER's listing of a container's children. Unset on the client, whose children arrive through the
// async server-tokens provider instead (client/TokenCache).
let indexerKeysProvider: ((container: IndexerContainerToken) => IndexerKey[]) | undefined;
export function setIndexerKeysProvider(fn: ((container: IndexerContainerToken) => IndexerKey[]) | undefined): void {
    indexerKeysProvider = fn;
}

export class IndexerContainerToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly info: IndexerInfo) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "[" + this.info.prefix + "]"; }
    override toString(): string { return "[" + this.info.niceName() + "]"; }
    niceName(): string { return "[" + this.info.niceName() + "]"; }
    get type(): TypeReference { return TR_INDEXER_CONTAINER; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    override get hideInAutoExpand(): boolean { return false; }
    protected override get autoExpandInternal(): boolean { return this.info.autoExpand; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }

    isAllowed(): string | null {
        return this._parent.isAllowed() ?? this.info.allowedReason?.() ?? null;
    }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return (indexerKeysProvider?.(this) ?? []).map(k => new ExtensionWithParameterToken(this, k));
    }
}

export class ExtensionWithParameterToken extends QueryToken {
    constructor(private readonly _parent: IndexerContainerToken, public readonly parameter: IndexerKey) {
        super();
        // Signum's Priority = -10: the keys sort after anything else offered beside them.
        this.priority = -10;
    }

    get parent(): IndexerContainerToken { return this._parent; }
    get key(): string { return "[" + this.parameter.key + "]"; }
    override toString(): string { return "[" + this.parameter.niceName + "]"; }
    niceName(): string { return this.parameter.niceName; }
    get type(): TypeReference { return this._parent.info.resultType; }
    get format(): string | undefined { return defaultFormat(this.type); }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return this._parent.info.implementations; }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.info.propertyRoute; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
