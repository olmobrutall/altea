// The operation HTTP API (Signum's OperationController.cs), on altea's typed `ws` wrapper (./webApi) —
// the server half of react/Operations.API. Register on a WebBuilder alongside Entities/Query:
//   OperationServer.start(ws);
//
// Each route resolves the operationKey → the registered OperationSymbol, dispatches to OperationLogic
// (execute / construct / delete), and returns an EntityPack (entity + canExecute) — except delete,
// which returns 204. The request body (entity / lite / args, all possibly entity graphs) is decoded
// by the entity Serializer via req.jsonTyped; the EntityPack is re-serialised by res.jsonTyped.

import { Entity } from "../data/entity";
import type { Lite } from "../data/lite";
import type { OperationSymbol, ExecuteSymbol, DeleteSymbol, ConstructSymbol, From, FromMany } from "../data/operations";
import type { EntityPack } from "../data/entityPack";
import { OperationLogic, Operations } from "./operationLogic";
import type { IEntityOperation } from "./operation";
import * as Database from "./Database";
import { WebBuilder, CustomType } from "./webApi";

interface EntityOperationRequest { entity: Entity; args?: unknown[]; }
interface LiteOperationRequest { lite: Lite<Entity>; args?: unknown[]; }
interface ConstructOperationRequest { type: string; args?: unknown[]; }
interface MultiOperationRequest { lites: Lite<Entity>[]; args?: unknown[]; }

export namespace OperationServer {

    export function start(ws: WebBuilder): void {

        // Execute on a posted entity → EntityPack. This is also how a SAVE happens (executing the
        // Save ExecuteSymbol); Signum has no dedicated save endpoint.
        ws.post("/api/operation/executeEntity/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<EntityOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { entity, args } = await req.jsonTyped() as EntityOperationRequest;
                const result = await Operations.execute(entity, resolve<ExecuteSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(getEntityPack(result));
            });

        // Execute on a lite → retrieve the entity, then execute (Signum's ExecuteLite).
        ws.post("/api/operation/executeLite/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<LiteOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { lite, args } = await req.jsonTyped() as LiteOperationRequest;
                const entity = await Database.retrieve(lite.entityType, lite.id);
                const result = await Operations.execute(entity, resolve<ExecuteSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(getEntityPack(result));
            });

        // Construct a new entity → EntityPack (or null when the constructor returns nothing).
        ws.post("/api/operation/construct/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<ConstructOperationRequest>(), res: CustomType<EntityPack<Entity> | undefined>() },
            async (req, res) => {
                const { args } = await req.jsonTyped() as ConstructOperationRequest;
                const result = await Operations.construct(resolve<ConstructSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(result != undefined ? getEntityPack(result) : undefined);
            });

        // Construct from a posted entity / a lite / many lites.
        ws.post("/api/operation/constructFromEntity/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<EntityOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { entity, args } = await req.jsonTyped() as EntityOperationRequest;
                const result = await Operations.constructFrom(entity, resolve<ConstructSymbol<Entity, From<Entity>>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(getEntityPack(result));
            });

        ws.post("/api/operation/constructFromLite/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<LiteOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { lite, args } = await req.jsonTyped() as LiteOperationRequest;
                const entity = await Database.retrieve(lite.entityType, lite.id);
                const result = await Operations.constructFrom(entity, resolve<ConstructSymbol<Entity, From<Entity>>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(getEntityPack(result));
            });

        ws.post("/api/operation/constructFromMany/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<MultiOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { lites, args } = await req.jsonTyped() as MultiOperationRequest;
                const result = await Operations.constructFromMany(lites, resolve<ConstructSymbol<Entity, FromMany<Entity>>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(getEntityPack(result));
            });

        // Delete a posted entity / a lite → 204.
        ws.post("/api/operation/deleteEntity/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<EntityOperationRequest>() },
            async (req, res) => {
                const { entity, args } = await req.jsonTyped() as EntityOperationRequest;
                await Operations.delete(entity, resolve<DeleteSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.status(204).end();
            });

        ws.post("/api/operation/deleteLite/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<LiteOperationRequest>() },
            async (req, res) => {
                const { lite, args } = await req.jsonTyped() as LiteOperationRequest;
                const entity = await Database.retrieve(lite.entityType, lite.id);
                await Operations.delete(entity, resolve<DeleteSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.status(204).end();
            });
    }
}

// Resolve an operation-key string to its registered OperationSymbol (Signum's SymbolLogic.ToSymbol).
function resolve<S extends OperationSymbol>(key: string): S {
    const sym = OperationLogic.registeredOperations().find(s => s.key === key);
    if (sym == undefined)
        throw new Error(`Operation '${key}' is not registered.`);
    return sym as S;
}

// Signum's SignumServer.GetEntityPack: the entity plus the canExecute of each entity operation
// (Execute / Delete / ConstructorFrom — the ones with onCanExecute) applicable to it. Operations of
// another type report a can't-execute reason (or throw, caught here), so they are simply omitted.
export function getEntityPack(entity: Entity): EntityPack<Entity> {
    // EntityPack.canExecute records an entry for EVERY entity operation applicable to this entity —
    // the reason string when disabled, "" when enabled (Signum's dict maps enabled → null). The KEY's
    // PRESENCE is what the client uses to decide the operation applies (EntityOperations filters an
    // existing entity's buttons on `oi.key in pack.canExecute`), so an enabled operation must still be
    // listed or it would never render. altea has no server-side per-type registry, so we evaluate every
    // registered operation; ones not applicable to this type throw (or report a state/reason) and are
    // simply filtered out client-side by TypeInfo.operations.
    const canExecute: Record<string, string> = {};
    for (const symbol of OperationLogic.registeredOperations()) {
        const op = OperationLogic.tryFindOperation(symbol);
        if (op != undefined && "onCanExecute" in op) {
            try {
                canExecute[symbol.key] = (op as IEntityOperation).onCanExecute(entity) ?? "";
            } catch { /* operation not applicable to this entity type */ }
        }
    }
    return { entity, canExecute };
}
