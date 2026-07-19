import { Connector } from "../connection/connector";
import { tryGetTypeInfo } from "../../entities/reflection";
import { setImplementedByAllTypesProvider } from "./tokens/queryToken";
import { getKey, type QueryName } from "./queryUtils";

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

// Wire the token layer's @implementedByAll provider (Signum sets this via the QueryLogic hooks in
// its static ctor / Start). Importing queryLogic activates byAll navigation.
setImplementedByAllTypesProvider(QueryLogic.getImplementedByAllTypes);
