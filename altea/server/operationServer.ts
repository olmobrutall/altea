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
import { Serializer } from "../data/serializer";
import type { OperationSymbol, ExecuteSymbol, DeleteSymbol, ConstructSymbol, From, FromMany } from "../data/operations";
import type { EntityPack } from "../data/entityPack";
import { OperationLogic, Operations } from "./operationLogic";
import type { IEntityOperation } from "./operation";
import * as Database from "./Database";
import { assertGraphIntegrityAsync } from "./graphExplorer";
import { Transaction } from "./connection/transaction";
import { ExceptionLogic } from "./exceptionLogic";
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
                // Phase 2: validate the just-deserialized entity graph (Signum's model-binder validation).
                // Server-only validators run here; the operation's own logic may fill fields before the
                // Saver's final "Saving" pass. Failures throw → 400 ModelState via the exceptionFilter.
                await assertGraphIntegrityAsync([entity], "ServerDeserialization");
                const result = await Operations.execute(entity, resolve<ExecuteSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(await getEntityPack(result));
            });

        // Execute on a lite → retrieve the entity, then execute (Signum's ExecuteLite).
        ws.post("/api/operation/executeLite/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<LiteOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { lite, args } = await req.jsonTyped() as LiteOperationRequest;
                const entity = await Database.retrieve(lite.entityType, lite.id);
                const result = await Operations.execute(entity, resolve<ExecuteSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(await getEntityPack(result));
            });

        // Construct a new entity → EntityPack (or null when the constructor returns nothing).
        ws.post("/api/operation/construct/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<ConstructOperationRequest>(), res: CustomType<EntityPack<Entity> | undefined>() },
            async (req, res) => {
                const { args } = await req.jsonTyped() as ConstructOperationRequest;
                const result = await Operations.construct(resolve<ConstructSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(result != undefined ? await getEntityPack(result) : undefined);
            });

        // Construct from a posted entity / a lite / many lites.
        ws.post("/api/operation/constructFromEntity/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<EntityOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { entity, args } = await req.jsonTyped() as EntityOperationRequest;
                const result = await Operations.constructFrom(entity, resolve<ConstructSymbol<Entity, From<Entity>>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(await getEntityPack(result));
            });

        ws.post("/api/operation/constructFromLite/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<LiteOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { lite, args } = await req.jsonTyped() as LiteOperationRequest;
                const entity = await Database.retrieve(lite.entityType, lite.id);
                const result = await Operations.constructFrom(entity, resolve<ConstructSymbol<Entity, From<Entity>>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(await getEntityPack(result));
            });

        ws.post("/api/operation/constructFromMany/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<MultiOperationRequest>(), res: CustomType<EntityPack<Entity>>() },
            async (req, res) => {
                const { lites, args } = await req.jsonTyped() as MultiOperationRequest;
                const result = await Operations.constructFromMany(lites, resolve<ConstructSymbol<Entity, FromMany<Entity>>>(req.params.operationKey), ...(args ?? []));
                res.jsonTyped(await getEntityPack(result));
            });

        // Execute / delete on MANY lites, one at a time, reporting per-lite (Signum's ExecuteMultiple /
        // DeleteMultiple). The response is NDJSON — one `{ entity, error? }` per line, flushed as each lite
        // finishes — because that is what the client reads: MultiOperationProgressModal streams the lines to
        // show progress, and with `progressModal: false` it just parses the single object.
        //
        // Each lite runs in its OWN transaction (Signum's ForeachNDJson): one failure must not roll back the
        // ones that already succeeded, and its message is reported against that lite instead of failing the
        // whole request. Signum's `Setters` (MultiSetter, "set these properties on all of them") are not
        // ported — altea's client sends none.
        const foreachNDJson = async (
            lites: Lite<Entity>[],
            res: { setHeader(name: string, value: string): void; write(chunk: string): void; end(): void },
            action: (entity: Entity) => Promise<void>,
        ): Promise<void> => {
            res.setHeader("Content-Type", "application/x-ndjson");
            for (const lite of lites) {
                let error: string | null = null;
                try {
                    await Transaction.forceNew(async () => {
                        const entity = await Database.retrieve(lite.entityType, lite.id);
                        await action(entity);
                    });
                } catch (e) {
                    error = (e as Error)?.message ?? String(e);
                    // Signum logs it too: a per-element failure is still a failure worth keeping.
                    try { await Transaction.forceNew(() => ExceptionLogic.logException(e)); } catch { /* never mask */ }
                }
                // `Serializer.stringify`, NOT `JSON.stringify`: a Lite is a CLASS here and its
                // `entityType` is a CONSTRUCTOR, which a plain stringify silently drops (functions are
                // skipped) — so the client's `Serializer.parse` gets a shapeless object back and the
                // `entity.key()` both readers call is undefined. Surfaced by altea-tree's Move, the first
                // contextual operation run on a SINGLE lite (the >1 path never touches `entity`).
                res.write(Serializer.stringify({ entity: lite, error }) + "\n");
            }
            res.end();
        };

        ws.post("/api/operation/executeMultiple/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<MultiOperationRequest>() },
            async (req, res) => {
                const { lites, args } = await req.jsonTyped() as MultiOperationRequest;
                const symbol = resolve<ExecuteSymbol<Entity>>(req.params.operationKey);
                await foreachNDJson(lites, res as never, entity => Operations.execute(entity, symbol, ...(args ?? [])).then(() => undefined));
            });

        ws.post("/api/operation/deleteMultiple/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<MultiOperationRequest>() },
            async (req, res) => {
                const { lites, args } = await req.jsonTyped() as MultiOperationRequest;
                const symbol = resolve<DeleteSymbol<Entity>>(req.params.operationKey);
                await foreachNDJson(lites, res as never, entity => Operations.delete(entity, symbol, ...(args ?? [])));
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
export async function getEntityPack(entity: Entity): Promise<EntityPack<Entity>> {
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
            // Row-level UI authorization (Signum's ServiceCanExecute): omit operations the current role
            // can't execute in the UI (inUserInterface:true), so DBOnly/None ops never render a button.
            if (!(await OperationLogic.isOperationAllowed(symbol, entity.constructor, true, entity)))
                continue;
            try {
                canExecute[symbol.key] = (op as IEntityOperation).onCanExecute(entity) ?? "";
            } catch { /* operation not applicable to this entity type */ }
        }
    }
    const pack: EntityPack<Entity> = { entity, canExecute };

    // Signum's `EntityPackTS.AddExtension` event: each module gets to stamp what its widgets need to
    // decide whether to render, so a frame costs one round-trip instead of one per widget.
    for (const fill of entityPackExtensions)
        await fill(pack);

    return pack;
}

export type EntityPackExtension = (pack: EntityPack<Entity>) => void | Promise<void>;

const entityPackExtensions: EntityPackExtension[] = [];

/**
 * Signum's `EntityPackTS.AddExtension += pack => pack.extension.Add("key", value)`. A module registers
 * a filler at start; it runs on every {@link getEntityPack}, so keep it cheap (a lazy lookup, not a query).
 * Write through {@link setEntityPackExtension} so the bag is created on demand.
 */
export function registerEntityPackExtension(fill: EntityPackExtension): void {
    entityPackExtensions.push(fill);
}

/** Set one key on a pack's extension bag, creating it if this is the first contributor. */
export function setEntityPackExtension(pack: EntityPack<Entity>, key: string, value: unknown): void {
    (pack.extension ??= {})[key] = value;
}
