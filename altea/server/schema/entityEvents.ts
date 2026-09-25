import type { Entity, Type } from '../../data/entity';
import { SqlPreCommand, Spacing } from '../sync/sqlPreCommand';
import type { Query } from '../query';
import type { LambdaExpression } from '../linq/expressions';
import type { RuntimeType } from '../runtimeTypes';
import type { FilterQueryArgs } from './filterQueryArgs';

// Signum's EntityEvents<T>, reached via `schema.entityEvents(ctor)`. Register by pushing onto an array.
// "Pre*" handlers run in reverse registration order, the rest in order. Every handler may be async.

// Signum's FilterQuery: a WHERE the binder adds to every query of T. Synchronous; undefined = no filter.
export type QueryFilterHandler = (ctx: {
    ctor: Type<Entity>;
    elementType: RuntimeType;
    args: FilterQueryArgs | undefined;
}) => LambdaExpression | undefined;

// Signum's RegisterBinding: a value folded into the retrieval SELECT of T and set on each instance.
export interface AdditionalBindingSpec<T extends Entity> {
    readonly valueLambda: LambdaExpression;
    readonly set: (entity: T, value: unknown) => void;
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
    }

    async onRetrieved(entity: T): Promise<void> {
        for (const h of this.retrieved)
            await h(entity);
    }

    async onPreUnsafeDelete(query: Query<T>): Promise<void> {
        for (const h of [...this.preUnsafeDelete].reverse())
            await h(query);
    }

    async onPreUnsafeUpdate(query: Query<T>): Promise<void> {
        for (const h of [...this.preUnsafeUpdate].reverse())
            await h(query);
    }

    // The rewrites chain: each handler sees the previous one's result.
    async onPreUnsafeInsert(query: Query<T>, constructor: LambdaExpression): Promise<LambdaExpression> {
        let current = constructor;
        for (const h of [...this.preUnsafeInsert].reverse())
            current = (await h(query, current)) ?? current;
        return current;
    }

    async onPreBulkInsert(): Promise<void> {
        for (const h of [...this.preBulkInsert].reverse())
            await h();
    }
}
