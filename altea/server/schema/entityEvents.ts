import type { Entity, Type } from '../../data/entity';
import { SqlPreCommand, Spacing } from '../sync/sqlPreCommand';
import type { Query } from '../query';
import type { LambdaExpression } from '../linq/expressions';
import type { RuntimeType } from '../runtimeTypes';
import type { FilterQueryArgs } from './filterQueryArgs';

// Signum's EntityEvents<T>, reached via `schema.entityEvents(ctor)`. Register by pushing onto an array.
// "Pre*" handlers run in reverse registration order, the rest in order. Every handler may be async.

// Signum's FilterQuery: a WHERE the binder adds to every query of T. Synchronous; undefined = no filter.
//
// `inMemory` is Signum's `FilterQueryResult.InMemoryFunction`: the same filter for ONE instance, for a row
// that no query read — one the CACHE serves (`Database.retrieve` of a cached type). Undefined (the result)
// = no filter. A handler WITHOUT it cannot be applied to a cached row, so altea-cache refuses to cache its
// type rather than serve rows the WHERE would have hidden.
export interface QueryFilterContext {
    ctor: Type<Entity>;
    elementType: RuntimeType;
    args: FilterQueryArgs | undefined;
}

export type QueryFilterHandler = ((ctx: QueryFilterContext) => LambdaExpression | undefined) & {
    inMemory?: (ctx: { ctor: Type<Entity> }) => ((entity: Entity) => boolean | Promise<boolean>) | undefined;
};

// Signum's RegisterBinding: a value folded into the retrieval SELECT of T and set on each instance.
// `setInMemory` is Signum's `SetInMemory`: the same value computed from the instance, for a row the CACHE
// serves (there is no SELECT to fold it into). Without it the type cannot be cached.
export interface AdditionalBindingSpec<T extends Entity> {
    readonly valueLambda: LambdaExpression;
    readonly set: (entity: T, value: unknown) => void;
    readonly setInMemory?: (entity: T) => void | Promise<void>;
}

export class EntityEvents<T extends Entity> {
    // SQL to run before a sync script deletes a row of T (see save.ts deleteSqlSync).
    readonly preDeleteSqlSync: ((entity: T) => SqlPreCommand | undefined | Promise<SqlPreCommand | undefined>)[] = [];
    // Before validation.
    readonly preSaving: ((entity: T) => void | Promise<void>)[] = [];
    // After validation, before the write.
    readonly saving: ((entity: T) => void | Promise<void>)[] = [];
    // After the write, inside the transaction.
    readonly saved: ((entity: T, args: { readonly wasNew: boolean; readonly wasModified: boolean }) => void | Promise<void>)[] = [];
    readonly retrieved: ((entity: T) => void | Promise<void>)[] = [];
    readonly preUnsafeDelete: ((query: Query<T>) => void | Promise<void>)[] = [];
    readonly preUnsafeUpdate: ((query: Query<T>) => void | Promise<void>)[] = [];
    // May return a replacement constructor lambda (e.g. altea-isolation stamps the isolation).
    readonly preUnsafeInsert: ((query: Query<T>, constructor: LambdaExpression) => LambdaExpression | void | Promise<LambdaExpression | void>)[] = [];
    readonly preBulkInsert: (() => void | Promise<void>)[] = [];
    // Rows of T are being written — by a save, or by a set-based DELETE / UPDATE / INSERT (a bulk insert
    // counts as an insert). For whoever only needs to know THAT T changed (a cache), not what or how;
    // runs after the matching specific event.
    readonly changed: ((method: EntityChangeMethod) => void | Promise<void>)[] = [];
    readonly queryFilter: QueryFilterHandler[] = [];
    readonly additionalBindings: AdditionalBindingSpec<T>[] = [];

    async onPreDeleteSqlSync(entity: T): Promise<SqlPreCommand | undefined> {
        if (this.preDeleteSqlSync.length === 0)
            return undefined;
        const commands: (SqlPreCommand | undefined)[] = [];
        for (const h of [...this.preDeleteSqlSync].reverse())
            commands.push(await h(entity));
        return SqlPreCommand.combine(Spacing.Simple, ...commands);
    }

    async onPreSaving(entity: T): Promise<void> {
        for (const h of this.preSaving)
            await h(entity);
    }

    async onSaving(entity: T): Promise<void> {
        for (const h of this.saving)
            await h(entity);
    }

    async onSaved(entity: T, args: { readonly wasNew: boolean; readonly wasModified: boolean }): Promise<void> {
        for (const h of this.saved)
            await h(entity, args);
        await this.onChanged("saved");
    }

    async onChanged(method: EntityChangeMethod): Promise<void> {
        for (const h of this.changed)
            await h(method);
    }

    /** Every queryFilter's in-memory half, applied to ONE instance (Signum's `GetInMemoryFilter`). Throws
     *  for a handler that has none — a caller reaching here has a row no WHERE filtered. */
    async isAllowedInMemory(ctor: Type<Entity>, entity: T): Promise<boolean> {
        for (const h of this.queryFilter) {
            if (h.inMemory == null)
                throw new Error(`A queryFilter of ${ctor.name} has no in-memory implementation, so a row read without a query cannot be filtered`);
            const f = h.inMemory({ ctor });
            if (f != null && !(await f(entity)))
                return false;
        }
        return true;
    }

    /** Every additional binding's in-memory half (Signum's `SetInMemory`), for a row the cache served. */
    async setAdditionalBindingsInMemory(entity: T): Promise<void> {
        for (const b of this.additionalBindings) {
            if (b.setInMemory == null)
                throw new Error(`An additional binding of ${entity.constructor.name} has no in-memory implementation, so a cached row cannot carry it`);
            await b.setInMemory(entity);
        }
    }

    async onRetrieved(entity: T): Promise<void> {
        for (const h of this.retrieved)
            await h(entity);
    }

    async onPreUnsafeDelete(query: Query<T>): Promise<void> {
        for (const h of [...this.preUnsafeDelete].reverse())
            await h(query);
        await this.onChanged("executeDelete");
    }

    async onPreUnsafeUpdate(query: Query<T>): Promise<void> {
        for (const h of [...this.preUnsafeUpdate].reverse())
            await h(query);
        await this.onChanged("executeUpdate");
    }

    // The rewrites chain: each handler sees the previous one's result.
    async onPreUnsafeInsert(query: Query<T>, constructor: LambdaExpression): Promise<LambdaExpression> {
        let current = constructor;
        for (const h of [...this.preUnsafeInsert].reverse())
            current = (await h(query, current)) ?? current;
        await this.onChanged("executeInsert");
        return current;
    }

    async onPreBulkInsert(): Promise<void> {
        for (const h of [...this.preBulkInsert].reverse())
            await h();
        await this.onChanged("executeInsert");
    }
}

/** How rows of an entity type are being written (see EntityEvents.changed). */
export type EntityChangeMethod = "saved" | "executeDelete" | "executeInsert" | "executeUpdate";
