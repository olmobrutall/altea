import type { Entity, PrimaryKey, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { DirectedGraph } from "@altea/altea/server/directedGraph";
import { GlobalLazy, GlobalLazyManager, type InvalidateWith } from "@altea/altea/server/globalLazy";
import { registerCacheController, type CacheController, type CacheRetriever } from "@altea/altea/server/cache";
import type { CustomLiteClass } from "@altea/altea/data/lite";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { SystemTime } from "@altea/altea/server/systemTime";
import type { IColumn } from "@altea/altea/server/schema/column";
import { FluentInclude } from "@altea/altea/server/schema/fluentInclude";
import {
    FieldEmbedded, FieldEntityArray, FieldEnum, FieldImplementedBy, FieldImplementedByAll,
    FieldMixin, FieldReference,
} from "@altea/altea/server/schema/field";
import type { EntityField } from "@altea/altea/server/schema/field";
import type { Schema } from "@altea/altea/server/schema/schema";
import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import type { Table } from "@altea/altea/server/schema/table";
import { CachedTableLite, CachedTable, CachedTableBase, installCachedTableHooks } from "./CachedTable";
import type { IServerBroadcast } from "./Broadcast/IServerBroadcast";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import { CachePermission } from "../data/CachePermission";

// Port of Signum's CacheLogic (Signum.Caching/CacheLogic.cs): which types are cached, when their rows are
// dropped, and how sibling processes are told. The row store itself lives in CachedTable.ts.
//
// The two Signum concepts to keep straight (`CacheType`):
//   • CACHED  — an `EntityData.Master` type: the whole table is held in memory and every retrieve is
//     served from it.
//   • SEMI    — an `EntityData.Transactional` type REFERENCED by a cached one: the table is far too
//     volatile to hold, but the referencing row still has to produce a `Lite<T>` display string, so just
//     the referenced lites are cached (CachedTableLite). A semi type is never served from the cache for
//     its own retrieves.
// Caching a type therefore pulls its whole dependency closure into one of the two roles, which is why
// `cacheTable` recurses (Signum's TryCacheSubTables).
//
// altea divergences (beyond those in CachedTable.ts):
//  - `withSqlDependency` is GONE, not optional: SQL Server query notifications need Service Broker
//    support in the client driver, and Node's (tedious) has none. Invalidation is always
//    "local events + optional broadcast", which is exactly Signum's non-SqlDependency configuration.
//  - Signum's `Schema.InvalidateMetadata()` has no analogue: altea's reflection metadata blob is
//    assembled per request, so there is nothing to invalidate.
//  - `ExecutionMode.IsCacheDisabled` is not ported (altea's ExecutionMode has only the `global` scope);
//    `CacheLogic.globallyDisabled` and the per-transaction disable cover every altea caller.

export type CacheType = "Cached" | "Semi" | "None";

export namespace CacheLogic {
    // Signum's CacheLogic.GloballyDisabled — the panel's Disable button. Every controller reads it.
    export let globallyDisabled = false;

    // Signum's CacheLogic.ServerBroadcast — the transport that tells sibling processes to invalidate.
    export let serverBroadcast: IServerBroadcast | undefined;

    // `undefined` value = SEMI (Signum stores a null controller for a semi-cached type).
    const controllers = new Map<Type<Entity>, CacheEntityController<Entity> | undefined>();
    // Signum's `semiControllers`: the lite tables that hold rows OF a semi-cached type, so a save to that
    // type can invalidate them.
    const semiControllers = new Map<Type<Entity>, CachedTableBase[]>();

    // Signum's `dependencies` / `inverseDependencies`: T → the types it references, and back. LOADING a
    // type loads everything it depends on; INVALIDATING a type invalidates everything that depends on it.
    const dependencies = new DirectedGraph<Type<Entity>>();
    const inverseDependencies = new DirectedGraph<Type<Entity>>();

    // Signum's EntityDataOverrides: force a type to be treated as Master/Transactional for caching.
    export const entityDataOverrides = new Map<Type<Entity>, "Master" | "Transactional">();

    export function overrideEntityData(type: Type<Entity>, data: "Master" | "Transactional"): void {
        entityDataOverrides.set(type, data);
    }

    let started = false;

    // Signum's CacheLogic.Start(sb, withSqlDependency, serverBroadcast).
    export function start(sb: SchemaBuilder, options?: { serverBroadcast?: IServerBroadcast }): void {
        if (sb.alreadyDefined(start))
            return;
        started = true;

        // A global lazy over CACHED types is invalidated by the cache's own events from now on — which
        // includes an invalidation BROADCAST from another process, something the base (local save/DML)
        // strategy can never see. Must happen before the first globalLazy registration.
        sb.switchGlobalLazyManager(new CacheGlobalLazyManager());

        setBuilderSchema(sb.schema);

        serverBroadcast = options?.serverBroadcast;
        if (serverBroadcast != null) {
            serverBroadcast.onReceive.push((method, argument) => broadcastReceivers[method]?.(argument));
            // Signum starts the transport on Schema.BeforeDatabaseAccess; altea's nearest hook is
            // `initializing` (which runs after generate/synchronize, before the host serves).
            sb.schema.initializing.push(() => serverBroadcast!.startIfNecessary());
        }

        // Signum's `GlobalLazy.OnResetAll += systemLog => CacheLogic.ForceReset(systemLog)`.
        GlobalLazy.onResetAll.push(() => forceReset());

        sb.schema.schemaCompleted.push(schemaCompleted);

        installCachedTableHooks({
            cachedLite: (targetType, column, owner, fieldCustomLite) => liteSourceFor(targetType, column, owner, fieldCustomLite),
            backReference: (childType, fkProperty, ownerId, retriever) =>
                requestByBackReference(childType, fkProperty, ownerId, retriever),
        });

        // The permission symbols only need their module imported to be seeded (SymbolLogic seeds the
        // declared set); referencing one here makes that dependency explicit.
        void CachePermission.ViewCache;
    }

    function assertStarted(): void {
        if (!started)
            throw new Error("CacheLogic.start(sb) must be called before caching a table");
    }

    // ---- Registration (Signum's CacheTable / TryCacheTable / TryCacheSubTables) --------------------

    // Signum's `CacheLogic.CacheTable<T>(sb)`: cache T (Master) or mark it semi-cached (Transactional),
    // then recurse into everything it references.
    export function cacheTable<T extends Entity>(sb: SchemaBuilder, type: Type<T>): void {
        assertStarted();
        if (controllers.has(type as unknown as Type<Entity>))
            return;

        const t = type as unknown as Type<Entity>;
        const data = entityDataOverrides.get(t) ?? getTypeInfo(t)?.entityData;

        if (data === "Master") {
            const controller = new CacheEntityController(t, sb.schema);
            controllers.set(t, controller);
            registerCacheController(t, controller);
            // Only a CACHED type's references are followed: its rows are materialised in full, so whatever
            // they point at has to be reachable from memory too.
            cacheSubTables(sb, t);
        } else {
            // Transactional (or unclassified): SEMI. Only the display columns of the ROWS a cached table
            // actually references are held (CachedTableLite), never the row itself — so the walk STOPS
            // here. Signum recurses into a semi type's own references as well, because a semi-cached
            // FULL-ENTITY reference there becomes a joined CachedTable that must materialise the whole
            // row. altea needs no such table: a full-entity reference on a cached row is left as a
            // Retriever STUB and completed from the database like any non-expanded reference. Recursing
            // anyway is what makes caching one Master type spread: Country → Lite<Person> → Person's own
            // references → … until most of the schema is registered, and every Master type met along the
            // way is loaded WHOLE.
            controllers.set(t, undefined);
            dependencies.add(t);
            inverseDependencies.add(t);
        }
    }

    function tryCacheTable(sb: SchemaBuilder, type: Type<Entity>): void {
        if (!controllers.has(type))
            cacheTable(sb, type);
    }

    // Signum's TryCacheSubTables: every table T's fields point at (its "dependent tables"), plus — this is
    // altea's VirtualMList equivalent — the child type of every `@part` collection, whose rows the cache
    // has to serve for T's collections to materialise.
    function cacheSubTables(sb: SchemaBuilder, type: Type<Entity>): void {
        dependencies.add(type);
        inverseDependencies.add(type);

        for (const related of relatedTypes(sb.schema.table(type))) {
            tryCacheTable(sb, related);
            dependencies.addEdge(type, related);
            inverseDependencies.addEdge(related, type);
        }
    }

    // The types a table's fields reference: FK targets (single / polymorphic / enum) and the child type of
    // each `@part` collection. @implementedByAll is skipped — its target can be ANY entity, so there is
    // nothing to cache (its lites carry type + id and no display string, exactly as in Signum).
    function relatedTypes(table: Table): Type<Entity>[] {
        const result = new Set<Type<Entity>>();

        const walk = (ef: EntityField): void => {
            const f = ef.field;
            if (f instanceof FieldEnum)
                return; // an enum table is seeded, immutable and read through its own registry — never cached
            if (f instanceof FieldReference) {
                result.add(f.column.referenceTable!.type as Type<Entity>);
                return;
            }
            if (f instanceof FieldImplementedBy) {
                for (const col of f.implementationColumns)
                    result.add(col.referenceTable!.type as Type<Entity>);
                return;
            }
            if (f instanceof FieldImplementedByAll)
                return;
            if (f instanceof FieldEmbedded) {
                for (const inner of Object.values(f.embeddedFields))
                    walk(inner);
                return;
            }
            if (f instanceof FieldEntityArray) {
                result.add(f.childType);
                return;
            }
        };

        for (const ef of Object.values(table.fields))
            walk(ef);
        for (const mixin of Object.values(table.mixins))
            for (const ef of Object.values(mixin.fields))
                walk(ef);

        return [...result];
    }

    // ---- Schema completed (Signum's Schema_SchemaCompleted) ----------------------------------------

    function schemaCompleted(schema: Schema): void {
        // Every cached type's completer, once every table (and every other cached table) exists.
        for (const controller of controllers.values())
            controller?.cachedTable.buildCompleter();

        // Signum refuses to cache a type whose row-level TypeConditions are DB-only: the cache serves rows
        // without running the query the condition lives in, so a cached read would bypass it. altea's
        // equivalent of "no in-memory TypeCondition" is an `additionalBindings` registration (a value the
        // binder folds into the retrieval SELECT — how a DB-eval type condition is delivered), which the
        // cached path cannot compute. Fail loudly at startup rather than silently under-filtering.
        const withBindings = [...controllers.entries()]
            .filter(([t, c]) => c != null && schema.entityEvents(t).additionalBindings.length > 0)
            .map(([t]) => t.name);

        if (withBindings.length > 0)
            throw new Error(
                `These types are cached but carry additional bindings (typically a DB-evaluated TypeCondition), which the cache cannot compute: ` +
                `${withBindings.join(", ")}. Register the condition with an in-memory evaluator, or do not cache the type.`);

        // ROW-LEVEL SECURITY. Signum guards this by requiring a cached type's TypeConditions to have an
        // in-memory evaluator, which its `Retrieved` handler then applies per entity. altea enforces row
        // security ONLY through `queryFilter` (a WHERE the LINQ binder splices into every query) — the
        // cached path issues no query, so a cached read of a conditioned type would return rows the role
        // must not see. Until a per-row retrieve gate exists, caching such a type is refused outright:
        // silently under-filtering is not an acceptable failure mode.
        const conditioned = [...controllers.entries()]
            .filter(([t, c]) => c != null && TypeConditionLogic.conditionsFor(t).length > 0)
            .map(([t]) => t.name);

        if (conditioned.length > 0)
            throw new Error(
                `These types are cached but have row-level TypeConditions, which altea enforces as a query filter — a cached read would ` +
                `bypass it: ${conditioned.join(", ")}. Do not cache a type with TypeConditions.`);
    }

    // ---- The per-type controller (Signum's inner CacheController<T>) ------------------------------

    class CacheEntityController<T extends Entity> implements CacheController<T> {
        readonly cachedTable: CachedTable<T>;
        // Signum's `event Invalidated` — the seam CacheGlobalLazyManager listens on. Each handler takes
        // "invalidated" (the rows are gone) or "disabled" (a write in the current transaction means the
        // rows can no longer be trusted until it commits).
        readonly invalidated: ((kind: "invalidated" | "disabled") => void)[] = [];

        constructor(readonly type: Type<Entity>, schema: Schema) {
            this.cachedTable = new CachedTable<T>(type as Type<T>, schema);

            const ee = schema.entityEvents(type);
            // Signum hooks `Saving` (before the write) with `IsGraphModified`; altea has no graph-modified
            // flag on the event, so it hooks `saved` — the write already happened, still inside the
            // transaction, which is what matters: the rows are stale from here on.
            ee.saved.push(() => this.disableAndInvalidate(true));
            ee.preUnsafeDelete.push(() => this.disableAndInvalidate(false));
            ee.preUnsafeUpdate.push(() => this.disableAndInvalidate(true));
            ee.preUnsafeInsert.push(() => this.disableAndInvalidate(true));
            ee.preBulkInsert.push(() => this.disableAndInvalidate(true));
        }

        // Signum's DisableAndInvalidate: mark the type (or, for an update, every type that depends on it)
        // untrusted for the REST OF THIS TRANSACTION, and drop the rows once it really commits.
        private disableAndInvalidate(withUpdates: boolean): void {
            if (withUpdates)
                disableAllConnectedTypesInTransaction(this.type);
            else
                disableTypeInTransaction(this.type);

            if (Transaction.hasTransaction()) {
                Transaction.postRealCommit(() => {
                    this.cachedTable.resetAll(false);
                    notifyInvalidateAllConnectedTypes(this.type);
                });
            } else {
                this.cachedTable.resetAll(false);
                notifyInvalidateAllConnectedTypes(this.type);
            }
        }

        get enabled(): boolean {
            // Signum also folds in ExecutionMode.IsCacheDisabled (not ported). SystemTime: a
            // system-versioned query asks for OLD row versions, which the cache does not hold.
            return !globallyDisabled
                && !isDisabledInTransaction(this.type)
                && SystemTime.current() == null;
        }

        get isLoaded(): boolean { return this.cachedTable.isLoaded; }

        // Signum's Load(): the type AND everything it depends on (a completer stubs/lites through them).
        async load(): Promise<void> {
            for (const t of dependencies.indirectlyRelatedTo(this.type, true)) {
                const c = controllers.get(t);
                if (c != null)
                    await c.cachedTable.loadAll();
            }
        }

        exists(id: PrimaryKey): boolean { return this.cachedTable.exists(id); }
        getAllIds(): PrimaryKey[] { return this.cachedTable.getAllIds(); }

        complete(entity: T, retriever: CacheRetriever): void {
            this.cachedTable.complete(entity, retriever);
        }

        tryGetLite(id: PrimaryKey, retriever: CacheRetriever): Lite<T> | null {
            if (!this.cachedTable.exists(id))
                return null;
            // altea has no lite MODEL to compute against the raw row (see CachedTable's header): the row
            // is materialised through the retriever and reduced by the type's own `toLite`, so a custom
            // lite (`registerCustomLite`) comes out exactly as a query would build it.
            const entity = retriever.entity(this.type, id, e => this.complete(e as T, retriever)) as T;
            return entity.toLite() as Lite<T>;
        }

        requestByBackReference(backReferenceField: string, ownerId: PrimaryKey, retriever: CacheRetriever): T[] {
            const ids = this.cachedTable.backReferenceIds(backReferenceField, ownerId);
            return ids.map(id => retriever.stub(this.type, id) as T);
        }

        notifyDisabled(): void {
            for (const h of this.invalidated)
                h("disabled");
        }

        notifyInvalidated(): void {
            for (const h of this.invalidated)
                h("invalidated");
        }

        forceReset(): void {
            this.cachedTable.resetAll(true);
        }
    }

    // ---- Hooks CachedTable calls back into ---------------------------------------------------------

    // Where a `Lite<Target>` on a cached row gets its display string. A CACHED target answers from its own
    // rows; a SEMI target gets a CachedTableLite hung off the owner (created once per owner+column, and
    // registered as the owner's sub-table so it resets and loads with it).
    function liteSourceFor(targetType: Type<Entity>, column: IColumn, owner: CachedTable<any>, fieldCustomLite: CustomLiteClass | undefined): (id: PrimaryKey, retriever: CacheRetriever) => Lite<Entity> | null {
        const controller = controllers.get(targetType);
        if (controller != null)
            return (id, retriever) => controller.tryGetLite(id, retriever);

        let sub = owner.subTables.find(st => st instanceof CachedTableLite && st.type === targetType && (st as CachedTableLite).column === column) as CachedTableLite | undefined;
        if (sub == null) {
            sub = new CachedTableLite(targetType, owner, column, fieldCustomLite, owner.schema);
            owner.subTables.push(sub);
            // Signum's semiControllers: a save to the semi type must drop these lites.
            const list = semiControllers.get(targetType);
            if (list != null) list.push(sub); else semiControllers.set(targetType, [sub]);
            attachSemiInvalidation(targetType);
        }
        const liteTable = sub;
        return id => liteTable.getLite(id);
    }

    // A `@part` collection of a cached owner: the child type's own cached rows, addressed by the child's
    // back-reference FK (Signum's RequestByBackReference).
    function requestByBackReference(childType: Type<Entity>, fkProperty: string, ownerId: PrimaryKey, retriever: CacheRetriever): Entity[] {
        const controller = controllers.get(childType);
        if (controller == null)
            throw new Error(`The collection child type ${childType.name} is not cached, so the collection of its owner cannot be served from the cache. ` +
                `A '@part' child inherits its owner's EntityData, so this normally means the owner is not EntityData.Master.`);
        return controller.requestByBackReference(fkProperty, ownerId, retriever);
    }

    // Signum's SemiCachedController: a save/DML on a SEMI type drops the lite tables that hold its rows.
    // Signum first checks whether the saved id is actually among the cached ones (and has the
    // MassiveInvalidationCheckLimit machinery for set-based DML); altea invalidates unconditionally —
    // a lite table is small, reloading it is one query, and the check itself costs a load.
    const semiAttached = new Set<Type<Entity>>();
    function attachSemiInvalidation(type: Type<Entity>): void {
        if (semiAttached.has(type))
            return;
        semiAttached.add(type);
        const schema = currentSchemaOf(type);
        const invalidate = (): void => {
            const list = semiControllers.get(type) ?? [];
            const reset = (): void => {
                for (const st of list)
                    st.resetAll(false);
                notifyInvalidateAllConnectedTypes(type);
            };
            if (Transaction.hasTransaction())
                Transaction.postRealCommit(reset);
            else
                reset();
        };
        const ee = schema.entityEvents(type);
        ee.saved.push(invalidate);
        ee.preUnsafeDelete.push(invalidate);
        ee.preUnsafeUpdate.push(invalidate);
        ee.preUnsafeInsert.push(invalidate);
        ee.preBulkInsert.push(invalidate);
    }

    // The schema a registered type belongs to. Every controller was built from ONE schema (the builder's),
    // so any controller's is the right one; `owner.schema` carries it for the lite tables.
    let builderSchema: Schema | undefined;
    function currentSchemaOf(_type: Type<Entity>): Schema {
        if (builderSchema == null)
            throw new Error("CacheLogic has no schema yet: call CacheLogic.start(sb) first");
        return builderSchema;
    }

    export function setBuilderSchema(schema: Schema): void {
        builderSchema = schema;
    }

    // ---- Disabled-in-transaction (Signum's DisabledTypesDuringTransaction) ------------------------

    const DISABLED_CACHES_KEY = "disabledCaches";

    function disabledTypesDuringTransaction(): Set<Type<Entity>> {
        const userData = Transaction.topParentUserData();
        let set = userData[DISABLED_CACHES_KEY] as Set<Type<Entity>> | undefined;
        if (set == null)
            userData[DISABLED_CACHES_KEY] = set = new Set<Type<Entity>>();
        return set;
    }

    function isDisabledInTransaction(type: Type<Entity>): boolean {
        if (!Transaction.hasTransaction())
            return false;
        const set = Transaction.topParentUserData()[DISABLED_CACHES_KEY] as Set<Type<Entity>> | undefined;
        return set != null && set.has(type);
    }

    function disableTypeInTransaction(type: Type<Entity>): void {
        if (!Transaction.hasTransaction())
            return;
        disabledTypesDuringTransaction().add(type);
        controllers.get(type)?.notifyDisabled();
    }

    function disableAllConnectedTypesInTransaction(type: Type<Entity>): void {
        if (!Transaction.hasTransaction())
            return;
        const set = disabledTypesDuringTransaction();
        for (const t of inverseDependencies.indirectlyRelatedTo(type, true)) {
            set.add(t);
            controllers.get(t)?.notifyDisabled();
        }
    }

    // ---- Invalidation + broadcast ------------------------------------------------------------------

    export const Method_InvalidateTable = "InvalidateTable";
    export const Method_InvalidateAllTables = "InvalidateAllTables";

    // Signum's NotifyInvalidateAllConnectedTypes: tell every type that DEPENDS on `type` (its rows embed
    // or reference it) that it is stale — locally, and over the broadcast so sibling processes do the same.
    function notifyInvalidateAllConnectedTypes(type: Type<Entity>): void {
        for (const t of inverseDependencies.indirectlyRelatedTo(type, true)) {
            controllers.get(t)?.notifyInvalidated();
            serverBroadcast?.send(Method_InvalidateTable, cleanNameOf(t));
        }
    }

    // Global lazies over types that are NOT cached: their reset handlers, so a broadcast from another
    // process invalidates them too (see CacheGlobalLazyManager.attachInvalidations).
    const lazyInvalidatorsByType = new Map<Type<Entity>, (() => void)[]>();

    // …and the other half of that: this process must also SEND when it writes such a type, or the peers
    // never hear. Signum gets this for free by force-caching a lazy's invalidateWith types (their
    // invalidation always broadcasts); altea deliberately does not cache them, so the send is wired here.
    // Without it a write from ANOTHER process — a terminal `import-assets` rewriting the toolbar rows, a
    // second api node saving an auth rule — leaves this process serving its stale lazy until a restart.
    // Sent on postRealCommit: a peer that reset on a write that then rolled back would reload the same
    // stale state and stay stale.
    const lazyBroadcastAttached = new Set<Type<Entity>>();

    function attachLazyBroadcast(sb: SchemaBuilder, type: Type<Entity>): void {
        if (lazyBroadcastAttached.has(type))
            return;
        lazyBroadcastAttached.add(type);

        const send = (): void => {
            if (serverBroadcast == null)
                return;
            const publish = (): void => serverBroadcast!.send(Method_InvalidateTable, cleanNameOf(type));
            if (Transaction.hasTransaction())
                Transaction.postRealCommit(publish);
            else
                publish();
        };

        const ee = sb.schema.entityEvents(type);
        ee.saved.push(send);
        ee.preUnsafeDelete.push(send);
        ee.preUnsafeUpdate.push(send);
        ee.preUnsafeInsert.push(send);
        ee.preBulkInsert.push(send);
    }

    /**
     * Signum's `CacheLogic.BroadcastReceivers` is a public dictionary any module adds to — the broadcast
     * transport is shared infrastructure, not the cache's private business (Signum.ConcurrentUser pushes
     * its own "ConcurrentUsersChanged" / "EntitySaved" methods through it). Registration is a function
     * rather than the raw record so a duplicate method name is an error instead of a silent overwrite.
     */
    export function registerBroadcastReceiver(method: string, receiver: (argument: string) => void): void {
        if (broadcastReceivers[method] != null)
            throw new Error(`CacheLogic.registerBroadcastReceiver: '${method}' is already registered`);
        broadcastReceivers[method] = receiver;
    }

    const broadcastReceivers: Record<string, (argument: string) => void> = {
        [Method_InvalidateTable]: cleanName => {
            const type = builderSchema?.nameToType.get(cleanName);
            if (type == null)
                return;
            const controller = controllers.get(type);
            if (controller != null) {
                controller.cachedTable.resetAll(false);
                controller.notifyInvalidated();
            } else {
                // Not cached itself but semi-cached (or purely a dependency): drop its lite tables.
                for (const st of semiControllers.get(type) ?? [])
                    st.resetAll(false);
            }
            for (const invalidate of lazyInvalidatorsByType.get(type) ?? [])
                invalidate();
        },
        [Method_InvalidateAllTables]: () => {
            invalidateAll(false);
        },
    };

    // Signum's ForceReset: drop every cached table AND its statistics.
    export function forceReset(): void {
        for (const controller of controllers.values())
            controller?.forceReset();
        for (const list of semiControllers.values())
            for (const st of list)
                st.resetAll(true);
    }

    // Signum's InvalidateAll: the cache, every global lazy, and (Signum) the metadata cache — altea has
    // none. `broadcast: false` when the call came FROM a broadcast, so it doesn't echo back.
    export function invalidateAll(broadcast = true): void {
        forceReset();
        GlobalLazy.resetAll();
        if (broadcast)
            serverBroadcast?.send(Method_InvalidateAllTables, "");
    }

    // ---- Introspection (Signum's GetCacheType / Statistics) ---------------------------------------

    export function getCacheType(type: Type<Entity>): CacheType {
        if (!controllers.has(type))
            return "None";
        return controllers.get(type) == null ? "Semi" : "Cached";
    }

    export function cachedTypes(): Type<Entity>[] {
        return [...controllers.keys()];
    }

    // Signum's Statistics(): the cached tables, biggest first.
    export function statistics(): CachedTableBase[] {
        return [...controllers.values()]
            .filter((c): c is CacheEntityController<Entity> => c != null)
            .map(c => c.cachedTable as CachedTableBase)
            .sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
    }

    function cleanNameOf(type: Type<Entity>): string {
        return builderSchema?.typeToName.get(type) ?? type.name;
    }

    // ---- The global-lazy strategy (Signum's CacheGlobalLazyManager) -------------------------------

    export class CacheGlobalLazyManager extends GlobalLazyManager {
        override attachInvalidations(sb: SchemaBuilder, invalidateWith: InvalidateWith, invalidate: () => void): void {
            if (globallyDisabled || invalidateWith.useBaseImplementation) {
                super.attachInvalidations(sb, invalidateWith, invalidate);
                return;
            }

            for (const t of invalidateWith.invalidateWith) {
                const controller = controllers.get(t);
                if (controller == null) {
                    // NOT cached. Signum FORCE-CACHES the type here (`TryCacheTable`), so that every
                    // global lazy is invalidated through the cache. altea deliberately does not: declaring
                    // `sb.globalLazy(…, { invalidateWith: [X] })` should not silently start holding X's
                    // whole table in memory — in this very repo that would have cached UserQuery,
                    // Dashboard and the Toolbar entities, all of which carry row-level TypeConditions a
                    // cached read cannot honour (see schemaCompleted). Instead the lazy keeps the base
                    // (local event) wiring AND is registered for the broadcast, so an invalidation from
                    // ANOTHER process still resets it — the one thing Signum's force-caching bought.
                    super.attachInvalidations(sb, { invalidateWith: [t] }, invalidate);
                    const list = lazyInvalidatorsByType.get(t);
                    if (list != null) list.push(invalidate); else lazyInvalidatorsByType.set(t, [invalidate]);
                    attachLazyBroadcast(sb, t);
                    continue;
                }
                controller.invalidated.push(kind => {
                    if (kind === "invalidated") {
                        invalidate();
                    } else {
                        // "disabled": a write in the CURRENT transaction. The lazy must not keep serving
                        // pre-write data to this transaction, and must reload once the write is real —
                        // and also if it rolls back (the eager reset already happened).
                        invalidate();
                        if (Transaction.hasTransaction())
                            Transaction.postRealCommit(() => invalidate());
                    }
                });
            }
        }

        // Signum's OnLoad: a lazy over cached types must find those caches loaded before it reads them.
        override async onLoad(_sb: SchemaBuilder, invalidateWith: InvalidateWith): Promise<void> {
            if (globallyDisabled || invalidateWith.useBaseImplementation)
                return;
            for (const t of invalidateWith.invalidateWith)
                await controllers.get(t)?.load();
        }
    }
}

// Signum's `FluentInclude<T>.WithCache()` — the one-liner an app writes:
//   sb.include(ShipperEntity).withCache()
declare module "@altea/altea/server/schema/fluentInclude" {
    interface FluentInclude<T extends Entity> {
        /** Hold this type's whole table in memory, invalidated on write (Signum's WithCache). */
        withCache(): this;
    }
}

FluentInclude.prototype.withCache = function <T extends Entity>(this: FluentInclude<T>): FluentInclude<T> {
    CacheLogic.setBuilderSchema(this.schemaBuilder.schema);
    CacheLogic.cacheTable(this.schemaBuilder, this.type);
    return this;
};

// Keep the unused-import checker honest about the fields only used through `instanceof` above.
void FieldMixin;
