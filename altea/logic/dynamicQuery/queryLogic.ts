import { Connector } from "../connection/connector";
import { tryGetTypeInfo } from "../../entities/reflection";
import { setImplementedByAllTypesProvider, setExtensionTokensProvider } from "./tokens/queryToken";
import { setBuildExtensionExpr } from "./tokens/extensionToken";
import { getKey, type QueryName } from "./queryUtils";
import type { QueryToken } from "./tokens/queryToken";
import { DynamicQueryContainer } from "./dynamicQueryContainer";
import { ExpressionContainer } from "./expressionContainer";

// Partial port of Signum's `QueryLogic` (Signum/Basics/QueryLogic.cs). Delivered here: the query
// name registry, the `@implementedByAll` sub-token type source (wired into the token layer), and
// the small schema predicates. Deferred pieces are listed under TODO below (and in TODO.md).
export namespace QueryLogic {
    // Signum's QueryNames (key → queryName). Populated by registerQuery (a stand-in for the
    // DynamicQueryContainer, deferred). Signum derives these from Queries.GetQueryNames().
    const queryNamesByKey = new Map<string, QueryName>();

    export function registerQuery(queryName: QueryName): void {
        queryNamesByKey.set(getKey(queryName), queryName);
    }

    // Signum's QueryLogic.Queries: the registry of executable queries (FluentInclude.withQuery
    // registers an AutoDynamicQueryCore here). registerQuery is kept for name-only registration.
    export const queries = new DynamicQueryContainer();

    // Signum's QueryLogic.Expressions: the registry of cross-entity extension expressions
    // (FluentInclude.withExpressionTo / withExpressionFrom register here). Owned by QueryLogic (the
    // token-layer hooks below point at this instance).
    export const expressions = new ExpressionContainer();

    // The entity-root token of a registered query (Signum's GetQueryDescription is gone — the query's
    // shape is a reflected type, columns are the root token's sub-tokens).
    export function tryGetRootToken(queryName: QueryName): QueryToken | undefined {
        return queries.tryGetCore(queryName) != undefined ? queries.rootToken(queryName) : undefined;
    }

    export function getRootToken(queryName: QueryName): QueryToken {
        return queries.rootToken(queryName);
    }

    export function queryNames(): ReadonlyMap<string, QueryName> {
        return queryNamesByKey;
    }

    export function tryToQueryName(key: string): QueryName | undefined {
        return queryNamesByKey.get(key);
    }

    export function toQueryName(key: string): QueryName {
        const n = queryNamesByKey.get(key);
        if (n == undefined)
            throw new Error(`QueryName with key '${key}' not found`);
        return n;
    }

    // Signum's QueryLogic.GetImplementedByAllSubTokens type set: every mapped entity type assignable
    // to `cleanTypeCtor` (Schema.Current.Tables.Keys). Reads the active connector's schema; returns
    // [] when there is no connector (navigation still works, it just yields no byAll sub-tokens).
    export function getImplementedByAllTypes(cleanTypeCtor: Function): Function[] {
        let schema;
        try {
            schema = Connector.current().schema;
        } catch {
            return [];
        }
        const out: Function[] = [];
        for (const t of schema.tables.keys()) {
            const ctor = t as unknown as Function;
            if (typeof ctor === "function" && (ctor === cleanTypeCtor || ctor.prototype instanceof cleanTypeCtor))
                out.push(ctor);
        }
        return out;
    }

    // Signum's QueryLogic.IsSystemVersioned: the type's table keeps row history (@systemVersioned).
    export function isSystemVersioned(ctor: Function): boolean {
        return tryGetTypeInfo(ctor)?.systemVersioned != undefined;
    }

    // Signum's QueryLogic.HasPartitionId — altea has no partition id column yet.
    export function hasPartitionId(_ctor: Function): boolean {
        return false;
    }

    // TODO(phase4): Start(sb) — Include<QueryEntity>().WithQuery(...), the QueryNameToEntity /
    // liteToEntity lazies, Schema_Generating (seed rows) and SynchronizeQueries (diff rows via the
    // Synchronizer). Depends on DynamicQueryContainer (WithQuery registration) + ExpressionContainer
    // (extension tokens), both unported. See TODO.md.
}

// Wire the token layer's hooks (Signum sets these via the QueryLogic hooks in its static ctor /
// Start). Importing queryLogic activates @implementedByAll navigation AND registered-expression
// sub-tokens.
setImplementedByAllTypesProvider(QueryLogic.getImplementedByAllTypes);
setExtensionTokensProvider(parent => QueryLogic.expressions.getExtensionsTokens(parent));
setBuildExtensionExpr((info, parentExpression) => QueryLogic.expressions.buildExtension(info, parentExpression));
