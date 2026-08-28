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
import { MultiSetter, type PropertySetter } from "./multiSetter";
import { PropertyRoute } from "../data/propertyRoute";

interface EntityOperationRequest { entity: Entity; args?: unknown[]; }
interface LiteOperationRequest { lite: Lite<Entity>; args?: unknown[]; }
interface ConstructOperationRequest { type: string; args?: unknown[]; }
interface MultiOperationRequest { lites: Lite<Entity>[]; args?: unknown[]; setters?: PropertySetter[]; }
/** Signum's StateCanExecuteRequest / StateCanExecuteResponse (OperationController.cs). */
interface StateCanExecuteRequest { lites: Lite<Entity>[]; operationKeys: string[]; }
interface StateCanExecuteResponse { canExecutes: Record<string, string>; isReadOnly: boolean; }

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
        // whole request.
        //
        // `setters` are Signum's MultiSetter ("apply these property changes to every one of them", from the
        // client's bulk-modifications dialog): applied to the freshly retrieved entity, inside its own
        // transaction, BEFORE the operation runs — so a rejected setter fails only that lite. The
        // property-auth snapshot is resolved ONCE for the whole request (it is immutable per request), the
        // way the (de)serialization boundary does it.
        const foreachNDJson = async (
            lites: Lite<Entity>[],
            setters: PropertySetter[] | undefined,
            res: { setHeader(name: string, value: string): void; write(chunk: string): void; end(): void },
            action: (entity: Entity) => Promise<void>,
        ): Promise<void> => {
            res.setHeader("Content-Type", "application/x-ndjson");
            const authContext = setters?.length ? await MultiSetter.resolveContext() : undefined;
            for (const lite of lites) {
                let error: string | null = null;
                try {
                    await Transaction.forceNew(async () => {
                        const entity = await Database.retrieve(lite.entityType, lite.id);
                        if (setters?.length)
                            MultiSetter.setSetters(entity, setters, PropertyRoute.root(entity.constructor as Function), authContext);
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
                const { lites, args, setters } = await req.jsonTyped() as MultiOperationRequest;
                const symbol = resolve<ExecuteSymbol<Entity>>(req.params.operationKey);
                await foreachNDJson(lites, setters, res as never, entity => Operations.execute(entity, symbol, ...(args ?? [])).then(() => undefined));
            });

        ws.post("/api/operation/deleteMultiple/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<MultiOperationRequest>() },
            async (req, res) => {
                const { lites, args, setters } = await req.jsonTyped() as MultiOperationRequest;
                const symbol = resolve<DeleteSymbol<Entity>>(req.params.operationKey);
                await foreachNDJson(lites, setters, res as never, entity => Operations.delete(entity, symbol, ...(args ?? [])));
            });

        // Signum's ConstructFromMultiple: run a ConstructFrom ONCE PER LITE (as opposed to
        // constructFromMany, which builds ONE entity out of the whole selection), reporting per lite. The
        // client has always called this route (Operations.API.constructFromMultiple — it is what a
        // contextual ConstructFrom over a multi-row selection posts to); it was simply never registered
        // here, so every such menu entry 404'd.
        ws.post("/api/operation/constructFromMultiple/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<MultiOperationRequest>() },
            async (req, res) => {
                const { lites, args, setters } = await req.jsonTyped() as MultiOperationRequest;
                const symbol = resolve<ConstructSymbol<Entity, From<Entity>>>(req.params.operationKey);
                await foreachNDJson(lites, setters, res as never, entity => Operations.constructFrom(entity, symbol, ...(args ?? [])).then(() => undefined));
            });

        // Delete a posted entity / a lite → 204.
        ws.post("/api/operation/deleteEntity/:operationKey",
            { params: CustomType<{ operationKey: string }>(), req: CustomType<EntityOperationRequest>() },
            async (req, res) => {
                const { entity, args } = await req.jsonTyped() as EntityOperationRequest;
                await Operations.delete(entity, resolve<DeleteSymbol<Entity>>(req.params.operationKey), ...(args ?? []));
                res.status(204).end();
            });

        // Signum's OperationController.StateCanExecutes: why each of these operations cannot run over the
        // SELECTION of a SearchControl — answered from the rows' distinct STATES, with no entity retrieved.
        // The contextual menu asks for it whenever it has more than one lite (or a ConstructFromMany, whose
        // reason cannot come from a single entity pack).
        //
        // The response field is `isReadOnly`, which is what Signum's CLIENT reads; its server writes
        // `AnyReadonly`, so the flag never actually reached the menu there.
        ws.post("/api/operation/stateCanExecutes",
            { req: CustomType<StateCanExecuteRequest>(), res: CustomType<StateCanExecuteResponse>() },
            async (req, res) => {
                const { lites, operationKeys } = await req.jsonTyped() as StateCanExecuteRequest;

                // Signum's `ParseOperationAssert` per (operationKey, selected type): resolve the symbol and
                // assert the current role may run it IN THE UI on that type. This is the route's only gate —
                // without it an anonymous caller could read the state distribution of any table by asking
                // (Signum's whole API is authorized globally by ASP.NET; altea gates per route).
                const types = [...new Set(lites.map(l => l.entityType as Function))];
                const symbols: OperationSymbol[] = [];
                for (const key of operationKeys) {
                    const symbol = resolve(key);
                    for (const type of types)
                        await OperationLogic.assertOperationAllowed(symbol, type, true, null);
                    symbols.push(symbol);
                }
                res.jsonTyped({
                    canExecutes: await OperationLogic.getContextualCanExecute(lites, symbols),
                    isReadOnly: await OperationLogic.anyReadonly(lites),
                });
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
// (Execute / Delete / ConstructorFrom — the ones with onCanExecute) applicable to it.
export async function getEntityPack(entity: Entity): Promise<EntityPack<Entity>> {
    // Signum's OperationLogic.ServiceCanExecute, filter for filter: the operations of THIS TYPE (its own
    // plus every one registered on a base it inherits from — `operationsForType` walks the prototype chain,
    // as Signum's polymorphic (type, symbol) registry does), keeping only the IEntityOperations that can run
    // on an entity in this state and that the current role may execute IN THE UI (so a DBOnly / None
    // operation never renders a button).
    //
    // The value is the reason when disabled and "" when enabled (Signum's dict maps enabled → null): it is
    // the KEY's PRESENCE that tells the client the operation applies at all — EntityOperations filters an
    // existing entity's buttons on `oi.key in pack.canExecute` — so an enabled operation must still be listed.
    //
    // NOT ported: Signum's `CreateMultiCanExecuteState` scope, a scratchpad a canExecute body may use to
    // share an expensive computation across the operations of one pack. Nothing in altea writes to it.
    const canExecute: Record<string, string> = {};
    for (const symbol of OperationLogic.operationsForType(entity.constructor)) {
        const op = OperationLogic.tryFindOperation(symbol);
        if (op == undefined || !("onCanExecute" in op))
            continue;

        const eo = op as IEntityOperation;
        if (entity.isNew && !eo.canBeNew)
            continue;

        if (!(await OperationLogic.isOperationAllowed(symbol, entity.constructor, true, entity)))
            continue;

        try {
            canExecute[symbol.key] = eo.onCanExecute(entity) ?? "";
        } catch (e) {
            // Signum rethrows with `e.Data["entity"] = entity`. This used to SWALLOW, because the loop ran
            // every operation in the application against every entity and most of them threw; now that the
            // list is the type's own, a throw here is a bug in that operation's canExecute and saying which
            // one is the whole point.
            throw new Error(`canExecute of '${symbol.key}' failed on ${entity}: ${(e as Error)?.message ?? e}`, { cause: e });
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
