import "../../data/globals"; // Array.prototype.toMap
import { Connector } from "../connection/connector";
import { tryGetTypeInfo } from "../../data/reflection";
import { setImplementedByAllTypesProvider, setExtensionTokensProvider, RootToken, SubTokensOptions, type QueryToken } from "../../data/dynamicQuery/tokens";
import { setBuildExtensionExpr } from "./tokenExpressions";
import { getKey, type QueryName } from "../../data/dynamicQuery/queryUtils";
import { DynamicQueryContainer } from "./dynamicQueryContainer";
import { ExpressionContainer } from "./expressionContainer";
import { QueryEntity } from "../../data/queryEntity";
import { insertSqlSyncGenerated, updateSqlSync, deleteSqlSync, copyRowFields } from "../save";
import { table as table_ } from "../table";
import { existsTable } from "../sync/syncTableRead";
import { Administrator } from "../Administrator";
import { Synchronizer, type Replacements } from "../sync/synchronizer";
import { SqlPreCommand, Spacing } from "../sync/sqlPreCommand";
import type { Entity, Type } from "../../data/entity";
import type { Schema } from "../schema/schema";
import type { SchemaBuilder } from "../schema/schemaBuilder";

// Partial port of Signum's `QueryLogic` (Signum/Basics/QueryLogic.cs). Delivered here: the query
// name registry, the `@implementedByAll` sub-token type source (wired into the token layer), and
// the small schema predicates. Deferred pieces are listed under TODO below (and in TODO.md).
export namespace QueryLogic {
    // Signum's QueryLogic.Queries: the registry of executable queries (FluentInclude.withQuery
    // registers an AutoDynamicQueryCore here) — and, since a query is named by its own TYPE, the
    // key→name registry too. There used to be a second `queryNamesByKey` map beside it, fed by a
    // `registerQuery` nothing outside a test ever called: every key lookup against it missed, and the
    // wire boundary silently fell back to resolveCleanType. One registry, and it is the one that
    // actually knows which queries exist.
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

    // Resolve a token from its fullKey string, walking down from the query's entity root (Signum's
    // QueryUtils.SubToken over a QueryDescription). An empty string ⇒ the root token itself. A
    // registered query supplies its own root; otherwise an entity-ctor queryName roots a plain
    // RootToken (so navigation works for any entity, not only explicitly registered queries).
    // NOTE: splits on "." — good for the common navigations; the dotted special tokens
    // ("[Operations].X", indexers) need a smarter parser (TODO, Signum's tokenizer).
    export function getToken(queryName: QueryName, tokenString: string, options: SubTokensOptions): QueryToken {
        // An unregistered type still navigates: its own RootToken. (Before QueryName narrowed to a
        // Type this needed a guard, because a string name had no type to root on.)
        let token: QueryToken = tryGetRootToken(queryName) ?? new RootToken(queryName);
        for (const part of tokenString.split(".").filter(p => p.length > 0)) {
            const sub: QueryToken | undefined = token.subToken(part, options);
            if (sub == undefined)
                throw new Error(`Token '${part}' not found on '${token.fullKey()}' (query '${getKey(queryName)}')`);
            token = sub;
        }
        return token;
    }

    /** The registered query with this key, or undefined (Signum's QueryLogic.TryToQueryName). */
    export function tryToQueryName(key: string): QueryName | undefined {
        return queries.tryGetQueryNameByKey(key);
    }

    /** As {@link tryToQueryName}, throwing when nothing is registered under `key`. */
    export function toQueryName(key: string): QueryName {
        const n = tryToQueryName(key);
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

    // Signum's QueryLogic.Start: include the QueryEntity system table, then seed one row per
    // registered query (generating), diff them on sync (synchronizing), and read them back into the
    // key↔entity cache (initializing). QueryEntity ids are used ONLY as the FK target of RuleQueryEntity
    // (query authorization) — they carry no cross-DB discriminator meaning (unlike TypeEntity), so no
    // deterministic bootstrap is needed; the DB assigns identity ids and load reads them back.
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;
        sb.include(QueryEntity as unknown as Type<Entity>).withQuery();
        sb.schema.generating.push(generateQueryEntities);
        sb.schema.synchronizing.push(synchronizeQueries);
        sb.schema.initializing.push(loadQueries);
    }

    // The persisted QueryEntity for a query (Signum's QueryLogic.GetQueryEntity, whose message is
    // "QueryName {0} not found on the database"). The three ways this fails are diagnosed separately,
    // because they need different fixes — and whether the query is REGISTERED is something this can
    // actually check, rather than assume: the container is the same registry the sync's `should` side
    // is built from, so "registered but not seeded" really does mean the database is behind.
    export function getQueryEntity(queryName: QueryName): QueryEntity {
        const key = getKey(queryName);
        const qe = queryEntitiesByKey.get(key);
        if (qe != null)
            return qe;

        if (queryEntitiesByKey.size === 0)
            throw new Error(`No QueryEntity row is loaded at all, so no query resolves — not just '${key}'. `
                + `Was QueryLogic.start included, and schema.initialize() run after generation?`);

        if (queries.tryGetCore(queryName) == undefined)
            throw new Error(`Query '${key}' is not registered. Register it with QueryLogic.queries.register `
                + `(or sb.include(...).withQuery()) before asking for its QueryEntity.`);

        throw new Error(`Query '${key}' is registered but is not on the database. Run a terminal sync.`);
    }

    export function tryGetQueryEntityByKey(key: string): QueryEntity | undefined {
        return queryEntitiesByKey.get(key);
    }

    /** Alias of {@link tryToQueryName}, kept for the query-auth callers that read it by this name. */
    export function tryGetQueryNameByKey(key: string): QueryName | undefined {
        return tryToQueryName(key);
    }

    // The queries whose shape roots on `ctor` (Signum's QueryLogic.GetTypeQueries). altea matches by the
    // core's root type rather than Signum's EntityImplementations.Types.Contains (no Implementations DTO) —
    // fine for the 1-auto-query-per-entity norm; abstract-base / multi-impl queries aren't matched (gap).
    export function getTypeQueries(ctor: Function): QueryName[] {
        return queries.getQueryNames().filter(qn => {
            const core = queries.tryGetCore(qn);
            return core != null && core.getRootType() === ctor;
        });
    }

    // Signum's DynamicQueryContainer.AllowQuery hook, here a settable async gate (core can't import
    // altea-auth). Installed by QueryAuthLogic.start; the query execute path (queryServer) awaits it with
    // fullScreen:false — so the server blocks only `None` (EmbeddedOnly stays executable), the full-screen
    // distinction being a client concern. Undefined → open.
    export let assertQueryAllowedHook: ((queryName: QueryName, fullScreen: boolean) => Promise<void>) | undefined;
}

// The loaded key → QueryEntity cache (Signum's QueryNameToEntity GlobalLazy). Module-level: query auth
// is a single-active-schema (eastwind) concern, unlike the per-schema TypeLogic caches. Re-read by
// loadQueries on schema.initialize() and after a sync.
let queryEntitiesByKey = new Map<string, QueryEntity>();

// The "should" row for a registered query key — id-less: generation and the sync's createNew both INSERT
// it without an id (the identity PK is DB-assigned), and the sync's mergeBoth copies its key onto the
// RETRIEVED row instead of re-building one around the persisted id.
function queryEntityFromKey(key: string): QueryEntity {
    const qe = new QueryEntity();
    qe.isNew = true;
    qe.key = key;
    return qe;
}

// Generation (Signum's QueryLogic.Schema_Generating): INSERT one row per registered query key (id
// DB-assigned). Sorted for a stable order. Runs after the table exists.
function generateQueryEntities(schema: Schema): SqlPreCommand | undefined {
    const table = schema.tryTable(QueryEntity as never);
    if (table == null)
        return undefined;
    const keys = QueryLogic.queries.getQueryNames().map(getKey).sort();
    return SqlPreCommand.combine(Spacing.Simple, ...keys.map(k => insertSqlSyncGenerated(table, queryEntityFromKey(k) as unknown as Entity)));
}

// Synchronization (Signum's QueryLogic.SynchronizeQueries): a new query key is INSERTed (DB assigns the
// id), a removed one DELETEd; a matched key keeps its persisted id and is only UPDATEd when the row
// drifted — which for this table means a RENAME (key is its only column). A freshly generated schema
// diffs to nothing.
async function synchronizeQueries(replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const connector = Connector.current();
    const schema = connector.schema;
    const table = schema.tryTable(QueryEntity as never);
    if (table == null)
        return undefined;

    // Both sides are dictionaries of QueryEntity ENTITIES — the entity is the unit of comparison.
    const should = QueryLogic.queries.getQueryNames().map(qn => queryEntityFromKey(getKey(qn))).toMap(qe => qe.key);

    // Ordinary LINQ read of the current rows; Administrator.tryRetrieveAll scopes the in-memory Table to
    // the name the database still uses when this table was renamed this run, and yields no rows when the
    // table does not exist yet (its CREATE is earlier in this same script). The retrieved entities ARE the
    // `current` dictionary: each carries its persisted id and the clean snapshot the Retriever took.
    const currentByKey = (await Administrator.tryRetrieveAll(QueryEntity, replacements)).toMap(qe => qe.key);

    return Synchronizer.synchronizeScriptReplacing<QueryEntity, QueryEntity>(
        replacements,
        "QueryKey",
        Spacing.Double,
        should,
        currentByKey,
        (_k, s) => insertSqlSyncGenerated(table, s as unknown as Entity),
        (_k, c) => deleteSqlSync(table, c as unknown as Entity),
        (_k, s, c) => {
            // Matched (possibly through a RENAME): write the registered key onto the RETRIEVED row, which
            // keeps its persisted id — every stored Lite<QueryEntity> (a UserQuery's `query`, a toolbar
            // element's content) points at it. updateSqlSync returns undefined unless the key drifted, so an
            // unchanged query contributes nothing and a RENAMED one gets its key column written.
            copyRowFields(c as unknown as Entity, s as unknown as Entity);
            return updateSqlSync(table, c as unknown as Entity);
        },
    );
}

// Initialization (Signum's QueryNameToEntity load): read the persisted QueryEntity rows back into the
// key↔entity cache. Tolerant of a not-yet-generated table (clears the cache until generation seeds it).
async function loadQueries(schema: Schema): Promise<void> {
    const next = new Map<string, QueryEntity>();
    const table = schema.tryTable(QueryEntity as never);
    if (table != null && (await existsTable(table.name))) {
        const rows = await table_(QueryEntity as never).toArray() as QueryEntity[];
        for (const r of rows)
            next.set(r.key, r);
    }
    queryEntitiesByKey = next;
}

// Wire the token layer's hooks (Signum sets these via the QueryLogic hooks in its static ctor /
// Start). Importing queryLogic activates @implementedByAll navigation AND registered-expression
// sub-tokens.
setImplementedByAllTypesProvider(QueryLogic.getImplementedByAllTypes);
setExtensionTokensProvider(parent => QueryLogic.expressions.getExtensionsTokens(parent));
setBuildExtensionExpr((info, parentExpression) => QueryLogic.expressions.buildExtension(info, parentExpression));
