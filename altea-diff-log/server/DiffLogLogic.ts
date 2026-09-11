import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { OperationLogic, type SurroundOperationAfter, type SurroundOperationContext } from "@altea/altea/server/operationLogic";
import { OperationType } from "@altea/altea/server/operation";
import * as Database from "@altea/altea/server/Database";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Entity } from "@altea/altea/data/entity";

import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { ObjectDumper } from "@altea/altea/data/objectDumper";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { FilterQueryArgs } from "@altea/altea/server/schema/filterQueryArgs";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import { DiffLogMixin, OperationLogTypeCondition } from "../data/DiffLog";
import { DiffLogServer } from "./DiffLogServer";

// Registers ONE surround-operation handler, and that handler is the whole module: dump the entity before
// the operation, dump the target after it, store both on the operation log. The after half still runs when
// the operation THREW.
//
// Port of Signum.DiffLog's DiffLogLogic.cs — see port/DiffLog.md.
export namespace DiffLogLogic {

    /** Per entity type, "is this worth dumping?". Keyed by ctor; a registration on a base type applies. */
    const shouldLogByType = new Map<Function, ShouldLogHandler>();

    export type ShouldLogHandler = (entity: Entity, operation: { key: string }) => boolean;

    /** A registration on a BASE type covers its subclasses. */
    export function registerShouldLog(type: Function, handler: ShouldLogHandler): void {
        shouldLogByType.set(type, handler);
    }

    /** The nearest registration up the prototype chain. */
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

        // The mixin must already be declared: the declaration is what puts the columns in the schema, and
        // it has to happen on both tiers, so the app owns the call.
        if (!DiffLogMixin.isDeclared())
            throw new Error("DiffLogLogic.start: DiffLogMixin is not declared on OperationLogEntity."
                + " Call DiffLogMixin.declare() from the app's shared entity-overrides module (BOTH tiers)"
                + " before building the schema.");

        // What the condition says: you may see an operation log BECAUSE you asked for the logs of ONE
        // entity that you are allowed to read. It answers a real problem — the operation log is a single
        // table across every type in the application, so a role that may read it at all could otherwise
        // read the audit trail of rows it cannot see — and it cannot be expressed as a predicate over the
        // log row, only over the QUERY that asked for it. Hence the auditor.
        //
        // `useInDBForInMemoryCondition: false`: the per-instance path reads `target` off the log in hand
        // (the log always carries it) rather than going back to the database for it.
        TypeConditionLogic.registerWhenAlreadyFilteringBy(
            OperationLogEntity, OperationLogTypeCondition.FilteringByTarget, {
            property: ol => ol.target,
            isConstantAuthorized: async target => target != null
                && await TypeAuthLogic.isAllowedForLite(target, TypeAllowedBasic.Read, true, FilterQueryArgs.fromLite(target)),
            useInDBForInMemoryCondition: false,
        });

        if (options?.registerAll ?? false)
            registerShouldLog(Entity, () => true);

        OperationLogic.surroundOperation.push(recordDumps);

        if (sb.webBuilder)
            DiffLogServer.start(sb.webBuilder);
    }

    async function recordDumps(ctx: SurroundOperationContext): Promise<SurroundOperationAfter> {
        const mixin = ctx.log.mixin(DiffLogMixin);
        const operationKey = ctx.operation.operationSymbol.key;

        let entity = ctx.entity;

        if (entity != null && shouldLog(entity, operationKey)) {
            // For a modifiable Execute the caller may already have mutated the graph, so the entity in hand
            // is NOT the initial state — re-read the stored one.
            if (ctx.operation.operationType === OperationType.Execute && !entity.isNew
                && isModifiableEntityOperation(ctx.operation) && entity.isDirty())
                entity = await retrieveFresh(entity);

            mixin.initialState = new BigStringEmbedded();
            mixin.initialState.text = ObjectDumper.dump(entity);
        } else {
            mixin.initialState = new BigStringEmbedded();
        }

        return () => {
            // The target the log ALREADY carries (set by logOperation before this runs), falling back to
            // the entity for an operation that never set one.
            const target = ctx.log.getTemporalTarget() ?? ctx.entity;

            if (target != null && shouldLog(target, operationKey) && ctx.operation.operationType !== OperationType.Delete) {
                mixin.finalState = new BigStringEmbedded();
                mixin.finalState.text = ObjectDumper.dump(target);
            } else {
                mixin.finalState = new BigStringEmbedded();
            }
        };
    }

    /** Only an entity operation declares `canBeModified`. */
    function isModifiableEntityOperation(operation: unknown): boolean {
        return (operation as { canBeModified?: boolean }).canBeModified === true;
    }

    /**
     * Read the stored row so the dump is the DATABASE state and not the caller's modified instance. A plain
     * retrieve suffices: the Retriever builds a fresh instance per read anyway.
     */
    async function retrieveFresh(entity: Entity): Promise<Entity> {
        return await ExecutionMode.global(() =>
            Database.retrieve(entity.constructor as never, entity.id!)) as Entity;
    }

}
