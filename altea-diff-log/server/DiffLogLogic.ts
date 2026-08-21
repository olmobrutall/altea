import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { OperationLogic, type SurroundOperationAfter, type SurroundOperationContext } from "@altea/altea/server/operationLogic";
import { OperationType } from "@altea/altea/server/operation";
import * as Database from "@altea/altea/server/Database";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Entity } from "@altea/altea/data/entity";

import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { ObjectDumper } from "@altea/altea/data/objectDumper";
import { DiffLogMixin } from "../data/DiffLog";
import { DiffLogServer } from "./DiffLogServer";

// Port of Signum.DiffLog's DiffLogLogic.cs — it registers ONE surround-operation handler, and that handler
// is the whole module: dump the entity before the operation, dump the target after it, store both on the
// operation log.
//
// altea divergences, documented inline:
//  - `OperationLogic.SurroundOperation += handler` returning an `IDisposable` becomes a handler on
//    `OperationLogic.surroundOperation` that returns an "after" callback (see the core hook, which this port
//    added). Same two halves, same order, and the after half still runs when the operation THREW.
//  - `Polymorphic<Func<IEntity, IOperation, bool>> ShouldLog` becomes a ctor-keyed Map walked up the
//    prototype chain: altea has no Polymorphic, and "the nearest registration for this type or a base of it"
//    is what Polymorphic's minimumType lookup means.
//  - `GraphExplorer.IsGraphModifiedVirtual(entity)` → `entity.isDirty()`. altea tracks modification against a
//    SNAPSHOT, so "the caller handed us a modified graph, re-read the stored one so the INITIAL state is
//    really the initial state" is the same check, one call instead of a graph walk.
//  - `CultureInfoUtils.ChangeBothCultures(Schema.ForceCultureInfo)` is dropped: altea's ObjectDumper formats
//    invariantly by construction (see its header), so there is no culture to pin.
//  - `TypeConditionLogic.RegisterWhenAlreadyFilteringBy(OperationLogTypeCondition.FilteringByTarget, …)` is
//    NOT ported — altea has no "only while the query already filters by this property" condition kind. The
//    symbol is still declared (see data/DiffLog.ts) so a role rule can reference it later.
export namespace DiffLogLogic {

    /** Signum's `ShouldLog` — per entity type, "is this worth dumping?". Keyed by ctor; base types apply. */
    const shouldLogByType = new Map<Function, ShouldLogHandler>();

    export type ShouldLogHandler = (entity: Entity, operation: { key: string }) => boolean;

    /** Signum's `RegisterShouldLog<T>(func)`. A registration on a BASE type covers its subclasses. */
    export function registerShouldLog(type: Function, handler: ShouldLogHandler): void {
        shouldLogByType.set(type, handler);
    }

    /** Signum's `ShouldLog.Invoke(entity, operation)` — the nearest registration up the prototype chain. */
    export function shouldLog(entity: Entity, operationKey: string): boolean {
        for (let ctor: Function | null = entity.constructor; ctor != null; ctor = Object.getPrototypeOf(ctor)) {
            const handler = shouldLogByType.get(ctor);
            if (handler != undefined)
                return handler(entity, { key: operationKey });
        }
        return false;
    }

    export function start(sb: SchemaBuilder, options?: { registerAll?: boolean }): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's `MixinDeclarations.AssertDeclared(typeof(OperationLogEntity), typeof(DiffLogMixin))`:
        // the mixin must already be declared, because the declaration is what puts the columns in the schema
        // — and it has to happen on both tiers, so the app owns the call.
        if (!DiffLogMixin.isDeclared())
            throw new Error("DiffLogLogic.start: DiffLogMixin is not declared on OperationLogEntity."
                + " Call DiffLogMixin.declare() from the app's shared entity-overrides module (BOTH tiers)"
                + " before building the schema.");

        if (options?.registerAll ?? false)
            registerShouldLog(Entity, () => true);

        OperationLogic.surroundOperation.push(recordDumps);

        if (sb.webBuilder)
            DiffLogServer.start(sb.webBuilder);
    }

    /** Signum's `OperationLogic_SurroundOperation`. */
    async function recordDumps(ctx: SurroundOperationContext): Promise<SurroundOperationAfter> {
        const mixin = ctx.log.mixin(DiffLogMixin);
        const operationKey = ctx.operation.operationSymbol.key;

        let entity = ctx.entity;

        if (entity != null && shouldLog(entity, operationKey)) {
            // Signum: for a modifiable Execute the caller may already have mutated the graph, so the entity
            // in hand is NOT the initial state — re-read the stored one.
            if (ctx.operation.operationType === OperationType.Execute && !entity.isNew
                && isModifiableEntityOperation(ctx.operation) && entity.isDirty())
                entity = await retrieveFresh(entity);

            mixin.initialState = new BigStringEmbedded();
            mixin.initialState.text = ObjectDumper.dump(entity);
        } else {
            mixin.initialState = new BigStringEmbedded();
        }

        return () => {
            // Signum reads `log.GetTemporalTarget()`: the target the log ALREADY carries (set by
            // logOperation before this runs), falling back to the entity for an operation that never set one.
            const target = ctx.log.getTemporalTarget() ?? ctx.entity;

            if (target != null && shouldLog(target, operationKey) && ctx.operation.operationType !== OperationType.Delete) {
                mixin.finalState = new BigStringEmbedded();
                mixin.finalState.text = ObjectDumper.dump(target);
            } else {
                mixin.finalState = new BigStringEmbedded();
            }
        };
    }

    /** Signum's `((IEntityOperation)operation).CanBeModified` — only an entity operation declares it. */
    function isModifiableEntityOperation(operation: unknown): boolean {
        return (operation as { canBeModified?: boolean }).canBeModified === true;
    }

    /**
     * Signum's `RetrieveFresh` — read the stored row, bypassing the identity map so the dump is the DATABASE
     * state and not the caller's modified instance. `new EntityCache(ForceNew)` becomes `ExecutionMode.global`
     * plus a direct retrieve: altea's Retriever builds a fresh instance per read anyway.
     */
    async function retrieveFresh(entity: Entity): Promise<Entity> {
        return await ExecutionMode.global(() =>
            Database.retrieve(entity.constructor as never, entity.id!)) as Entity;
    }

}
