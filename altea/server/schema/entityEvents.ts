import type { Entity } from '../../data/entity';
import { SqlPreCommand, Spacing } from '../sync/sqlPreCommand';
import type { Query } from '../query';
import type { LambdaExpression } from '../linq/expressions';
import type { RuntimeType } from '../runtimeTypes';

// Port of Signum's EntityEvents<T> (Engine/Schema/EntityEvents.cs): the per-entity-type hook
// surface the engine fires as it interacts with a type (save, retrieve, delete, unsafe DML,
// bulk insert). Held per-schema in a Map keyed by the entity ctor and reached via
// `Schema.entityEvents(ctor)`, the analogue of Signum's `Schema.EntityEvents<T>()`. A module
// registers handlers in its `start()` by pushing onto the relevant array (Signum's `+=`).
//
// Firing order mirrors Signum: the "Pre*" hooks fire in REVERSE registration order
// (GetInvocationListTyped().Reverse() — a later registrant runs first), the plain notifications
// (Saving / Saved / Retrieved) fire in registration order.
//
// altea divergences (documented, faithful where the infrastructure exists):
//  - Signum's PreSaving/Saved carry a PreSavingContext / SavedEventArgs; altea passes just the
//    entity (+ `wasNew` on Saved), since the graph-regeneration/replacement context those carry
//    has no altea analogue.
//  - the unsafe-DML hooks (PreUnsafeDelete/Update/Insert) are pre-execution async callbacks
//    receiving the source Query, NOT Signum's IDisposable-returning scopes: a handler runs its
//    own work (e.g. cascade-delete children) before the operation. The dispose-after phase and
//    PreUnsafeInsert's constructor-rewriting are not ported (no consumer needs them yet).
//  - `queryFilter` IS ported (Signum's FilterQuery, row-level query security) — see below. NOT ported
//    (no altea infrastructure yet): CacheController (no caching module), AlternativeRetrieve (custom
//    retrieval), and RegisterBinding / AdditionalBindings (Signum's MList / VirtualMList binding — altea
//    has no MList). Add them here + at their engine path when that infrastructure lands.

// Handler signatures (Signum's event delegate types).
export type PreDeleteSqlSyncHandler<T extends Entity> = (entity: T) => SqlPreCommand | undefined;
export type PreSavingHandler<T extends Entity> = (entity: T) => void;
export type SavingHandler<T extends Entity> = (entity: T) => void;
export interface SavedArgs { readonly wasNew: boolean; }
export type SavedHandler<T extends Entity> = (entity: T, args: SavedArgs) => void;
export type RetrievedHandler<T extends Entity> = (entity: T) => void;
export type PreUnsafeDeleteHandler<T extends Entity> = (query: Query<T>) => void | Promise<void>;
export type PreUnsafeUpdateHandler<T extends Entity> = (query: Query<T>) => void | Promise<void>;
export type PreUnsafeInsertHandler<T extends Entity> = (query: Query<T>) => void | Promise<void>;
export type PreBulkInsertHandler = () => void;
// An opaque, per-translation bag of row-level-security data (Signum keeps its FilterQuery caches always
// warm; altea can't — no sync DB — so it resolves them ON DEMAND). Each async provider registered on the
// Schema (`queryFilterProviders`) contributes ONE entry, under its own key, BEFORE a query is translated;
// the SYNC `queryFilter` handlers then read their own entry back during binding, casting the opaque value
// to the shape they stored. Empty when no provider is registered.
export type QueryFilterContext = ReadonlyMap<string, unknown>;

// Signum's FilterQuery: contribute a boolean predicate (a LambdaExpression over the entity `elementType`)
// that the LINQ binder splices as a WHERE onto EVERY query of T — Database.retrieve, dynamic queries,
// navigations — so row-level security applies uniformly. SYNCHRONOUS (the binder is sync): a handler reads
// what it needs synchronously from `filterContext` (populated async before translation — see
// Schema.buildQueryFilterContext), never the DB. Returns undefined for "no restriction".
export type QueryFilterHandler = (ctx: { ctor: Function; elementType: RuntimeType; filterContext: QueryFilterContext }) => LambdaExpression | undefined;

export class EntityEvents<T extends Entity> {
    // Signum's `event Func<T, SqlPreCommand?> PreDeleteSqlSync` — contribute SQL that must run
    // BEFORE a row of T is deleted by a synchronization script (see save.ts deleteSqlSync).
    readonly preDeleteSqlSync: PreDeleteSqlSyncHandler<T>[] = [];
    // Before validation (Signum's PreSaving).
    readonly preSaving: PreSavingHandler<T>[] = [];
    // After validation, before the DB write (Signum's Saving).
    readonly saving: SavingHandler<T>[] = [];
    // After the DB write, inside the transaction (Signum's Saved).
    readonly saved: SavedHandler<T>[] = [];
    // After an entity is materialised and fully populated (Signum's Retrieved).
    readonly retrieved: RetrievedHandler<T>[] = [];
    // Before a set-based (unsafe) DELETE / UPDATE / INSERT of T executes (Signum's PreUnsafe*).
    readonly preUnsafeDelete: PreUnsafeDeleteHandler<T>[] = [];
    readonly preUnsafeUpdate: PreUnsafeUpdateHandler<T>[] = [];
    readonly preUnsafeInsert: PreUnsafeInsertHandler<T>[] = [];
    // Before a bulk-copy of T (Signum's PreBulkInsert; altea has no MList table, so no arg).
    readonly preBulkInsert: PreBulkInsertHandler[] = [];
    // Row-level query filter (Signum's FilterQuery) — a WHERE the binder adds to every query of T.
    readonly queryFilter: QueryFilterHandler[] = [];

    // Combine every PreDeleteSqlSync handler's SQL (Signum's OnPreDeleteSqlSync) — reverse
    // registration order, Spacing.Simple; undefined when nothing is registered.
    onPreDeleteSqlSync(entity: T): SqlPreCommand | undefined {
        if (this.preDeleteSqlSync.length === 0)
            return undefined;
        return SqlPreCommand.combine(Spacing.Simple, ...[...this.preDeleteSqlSync].reverse().map(h => h(entity)));
    }

    onPreSaving(entity: T): void {
        for (const h of this.preSaving)
            h(entity);
    }

    onSaving(entity: T): void {
        for (const h of this.saving)
            h(entity);
    }

    onSaved(entity: T, args: SavedArgs): void {
        for (const h of this.saved)
            h(entity, args);
    }

    onRetrieved(entity: T): void {
        for (const h of this.retrieved)
            h(entity);
    }

    // The unsafe-DML pre-hooks run every handler (reverse order), awaiting async ones, before the
    // command executes — so a handler can e.g. cascade-delete dependent rows first.
    async onPreUnsafeDelete(query: Query<T>): Promise<void> {
        for (const h of [...this.preUnsafeDelete].reverse())
            await h(query);
    }

    async onPreUnsafeUpdate(query: Query<T>): Promise<void> {
        for (const h of [...this.preUnsafeUpdate].reverse())
            await h(query);
    }

    async onPreUnsafeInsert(query: Query<T>): Promise<void> {
        for (const h of [...this.preUnsafeInsert].reverse())
            await h(query);
    }

    onPreBulkInsert(): void {
        for (const h of [...this.preBulkInsert].reverse())
            h();
    }
}
