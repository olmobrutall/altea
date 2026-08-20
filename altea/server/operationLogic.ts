import { Entity } from "../data/entity";
import type { Lite } from "../data/lite";
import { OperationSymbol } from "../data/operations";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../data/operations";
import { OperationLogEntity } from "../data/operationLog";
import { resolveCleanType, resolveType } from "../data/registration";
import { Temporal } from "../data/basics";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import { SymbolLogic } from "./symbolLogic";
import { Saver } from "./saver";
import { ExceptionLogic } from "./exceptionLogic";
import { UnauthorizedAccessException } from "./exceptions";
import { UserHolder } from "./userHolder";
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import {
    OperationType,
    type IOperation, type IEntityOperation, type IExecuteOperation, type IDeleteOperation,
    type IConstructOperation, type IConstructorFromOperation, type IConstructorFromManyOperation,
} from "./operation";

// Port of Signum's OperationLogic (Signum/Operations/OperationLogic.cs): the operation
// registry + the service entrypoints. (OperationType + the IOperation interfaces live in
// ./operation; the Graph.* operation classes in ./graph.) Deferred vs Signum:
// OperationLogEntity + logging, authorization, the RequiresSaveOperation save-guard.
// Divergence: the registry is keyed by OperationSymbol alone (not Signum's polymorphic
// (type,symbol)) — one impl per symbol, no operation inheritance — which is all Southwind needs.
// Each operation does declare its owning entity type explicitly (`entityType` in the Graph options,
// Signum's OverridenType), because a generic parameter is erased at runtime and the owner must be
// EXACT: it is the key the reflection metadata blob ships the operation under.

const operations = new Map<OperationSymbol, IOperation>();

// entity ctor → the operations registered on it, maintained alongside `operations`. Rebuilt on every
// register/unregister rather than derived on demand, because the metadata blob reads it per request.
const operationsByType = new Map<Function, Set<OperationSymbol>>();

export namespace OperationLogic {
    // Signum's OperationLogic.Register(replace). Validates the operation, then stores it
    // by symbol. `replace` allows an external module to swap an operation's impl.
    export function register(operation: IOperation, replace = false): void {
        if (!replace && operations.has(operation.operationSymbol))
            throw new Error(`Operation '${operation.operationSymbol.key}' has already been registered (pass replace=true to override).`);
        operation.assertIsValid();
        const previous = operations.get(operation.operationSymbol);
        if (previous != null && previous.entityType !== operation.entityType)
            operationsByType.get(previous.entityType)?.delete(operation.operationSymbol);
        operations.set(operation.operationSymbol, operation);
        let byType = operationsByType.get(operation.entityType);
        if (byType == null) operationsByType.set(operation.entityType, byType = new Set());
        byType.add(operation.operationSymbol);
    }

    // Remove an operation entirely (so it can be re-registered differently, or dropped).
    export function unregister(symbol: OperationSymbol): boolean {
        const op = operations.get(symbol);
        if (op != null)
            operationsByType.get(op.entityType)?.delete(symbol);
        return operations.delete(symbol);
    }

    export function registeredOperations(): OperationSymbol[] {
        return [...operations.keys()];
    }

    export function tryFindOperation(symbol: OperationSymbol): IOperation | undefined {
        return operations.get(symbol);
    }
    export function findOperation(symbol: OperationSymbol): IOperation {
        const op = operations.get(symbol);
        if (op == null)
            throw new Error(`Operation '${symbol.key}' is not registered.`);
        return op;
    }

    // Signum's `OperationLogic.AllowOperation` event (Operations/OperationLogic.cs) — a pluggable
    // authorization gate. altea core can't import altea-auth, so an auth module installs a hook via
    // `onAllowOperation`; `assertOperationAllowed` (execute-time, inUserInterface:false) throws when
    // denied, and `isOperationAllowed` (button-state, inUserInterface:true) is the boolean form used by
    // getEntityPack to hide operations. `inUserInterface` distinguishes "the client may click it" (Allow)
    // from "server code may run it" (DBOnly or Allow). No hook installed → open (returns true / no throw).
    export type AllowOperationHook =
        (symbol: OperationSymbol, entityType: Function, inUserInterface: boolean, entity: Entity | null) => Promise<boolean>;
    const allowOperationHooks: AllowOperationHook[] = [];
    export function onAllowOperation(fn: AllowOperationHook): void { allowOperationHooks.push(fn); }

    export async function isOperationAllowed(symbol: OperationSymbol, entityType: Function, inUserInterface: boolean, entity: Entity | null): Promise<boolean> {
        for (const h of allowOperationHooks)
            if (!(await h(symbol, entityType, inUserInterface, entity)))
                return false;
        return true;
    }
    export async function assertOperationAllowed(symbol: OperationSymbol, entityType: Function, inUserInterface: boolean, entity: Entity | null): Promise<void> {
        if (!(await isOperationAllowed(symbol, entityType, inUserInterface, entity)))
            throw new UnauthorizedAccessException(`Operation '${symbol.key}' is not authorized`);
    }

    /**
     * The operations registered on an entity type — INCLUDING those declared on an abstract base it
     * inherits from, which is how Signum's polymorphic (type, symbol) registry behaves and what a
     * concrete subtype's frame must show. Used by the metadata builder and the auth admin pack.
     *
     * Was previously derived from the `<Type>Operation.<Member>` key convention, which silently missed
     * every operation whose container is not named after its type (and every abstract-base one).
     */
    export function operationsForType(ctor: Function): OperationSymbol[] {
        const result: OperationSymbol[] = [];
        for (const [owner, symbols] of operationsByType)
            if (owner === ctor || ctor.prototype instanceof owner)
                // A symbol can be indexed before its implementation is registered (see registerForType);
                // one that never gets an implementation is not an operation of this type.
                for (const s of symbols)
                    if (operations.has(s)) result.push(s);
        return result;
    }

    /** As {@link operationsForType}, by clean type name (the auth admin pack works in names). */
    export function operationsForTypeName(cleanTypeName: string): OperationSymbol[] {
        const ctor = resolveCleanType(cleanTypeName) ?? resolveType(cleanTypeName);
        return ctor == null ? [] : operationsForType(ctor);
    }

    /**
     * ALSO register an existing operation on another type (Signum's polymorphic (type, symbol) registry).
     * For an operation whose owner is a TS INTERFACE — which has no runtime constructor, so it cannot be
     * an `entityType` — each implementor adds itself as it is wired up: SchedulerLogic does this for
     * `ITaskOperation.ExecuteSync` from `registerExecuteTask`. The implementation stays the one registered
     * under the symbol; only the ownership set widens.
     *
     * Order-independent by design: the symbol need NOT be registered yet. An implementor can wire itself
     * up before the module that owns the operation gets to its graph (SimpleTaskLogic.start runs before
     * SchedulerLogic registers ITaskOperation), and readers skip a symbol with no implementation anyway.
     */
    export function registerForType(symbol: OperationSymbol, ctor: Function): void {
        let byType = operationsByType.get(ctor);
        if (byType == null) operationsByType.set(ctor, byType = new Set());
        byType.add(symbol);
    }

    /** Every entity ctor that has at least one operation registered on it (the metadata builder). */
    export function typesWithOperations(): Function[] {
        return [...operationsByType.keys()];
    }

    // Signum's OperationLogic.Start: wires the OperationSymbol table through SymbolLogic,
    // seeding only the RegisteredOperations, and includes the OperationLogEntity table + its query
    // (Signum's sb.Include<OperationLogEntity>().WithQuery(...)). Call AFTER the graphs have registered.
    export function start(sb: SchemaBuilder): void {
        SymbolLogic.start(sb, OperationSymbol, () => registeredOperations());
        sb.include(OperationLogEntity).withQuery();
    }
}

// Signum wraps every operation execution in a transaction that also writes an OperationLogEntity
// (OperationLogic.OnSuspiciousOperation / the OperationRunner). altea has no ambient transaction yet, so
// the log is a best-effort side write: the operation runs, then the log row is persisted. A log-save
// failure is swallowed (console.error) so it can NEVER mask the operation's own result — in particular,
// if the OperationLog table hasn't been created yet (needs `terminal sync`), operations keep working and
// logging is simply skipped. Divergence from Signum, whose logging is transactional.
async function logOperation<T>(
    symbol: OperationSymbol,
    origin: Entity | null,
    run: () => Promise<T>,
    getTarget: (result: T) => Entity | null,
): Promise<T> {
    const log = new OperationLogEntity();
    log.operation = symbol;
    log.origin = origin == null || origin.isNew ? null : origin.toLite();
    log.user = UserHolder.currentUserLite();
    log.start = Temporal.Now.plainDateTimeISO();
    try {
        const result = await run();
        log.setTarget(getTarget(result));
        log.end = Temporal.Now.plainDateTimeISO();
        await persistLog(log);
        return result;
    } catch (error) {
        log.end = Temporal.Now.plainDateTimeISO();
        // Link the exception row (Signum's OperationLogEntity.Exception) — best-effort.
        try {
            const ex = await ExceptionLogic.logException(error);
            log.exception = ex.isNew ? null : ex.toLite();
        } catch (exError) {
            console.error("OperationLogic.logOperation: failed to log exception:", exError);
        }
        await persistLog(log);
        throw error;
    }
}

async function persistLog(log: OperationLogEntity): Promise<void> {
    try {
        await Saver.save([log]);
    } catch (saveError) {
        console.error("OperationLogic.logOperation: failed to persist OperationLogEntity:", saveError);
    }
}

function find(symbol: OperationSymbol, type: OperationType): IOperation {
    const op = OperationLogic.findOperation(symbol);
    if (op.operationType !== type)
        throw new Error(`Operation '${symbol.key}' is a ${op.operationType}, not a ${type}.`);
    return op;
}

// Service entrypoints (Signum's OperationLogic.Execute/Delete/Construct/… extension
// methods). An object literal so `delete` (reserved word) works as a method. Typed by
// the symbol containers, so the compiler rejects the wrong operation kind / entity type.
export const Operations = {
    async execute<T extends Entity>(entity: T, symbol: ExecuteSymbol<T>, ...args: unknown[]): Promise<T> {
        // Signum's execute-time authorization (Graph.Execute → AssertOperationAllowed, inUserInterface:false).
        await OperationLogic.assertOperationAllowed(symbol, entity.constructor, false, entity);
        return await logOperation(symbol, null,
            () => (find(symbol, OperationType.Execute) as IExecuteOperation).doExecute(entity, args) as Promise<T>,
            result => result);
    },
    async delete<T extends Entity>(entity: T, symbol: DeleteSymbol<T>, ...args: unknown[]): Promise<void> {
        await OperationLogic.assertOperationAllowed(symbol, entity.constructor, false, entity);
        await logOperation(symbol, null,
            () => (find(symbol, OperationType.Delete) as IDeleteOperation).doDelete(entity, args),
            () => entity);
    },
    async construct<T extends Entity>(symbol: ConstructSymbol<T>, ...args: unknown[]): Promise<T> {
        return await logOperation(symbol, null,
            () => (find(symbol, OperationType.Constructor) as IConstructOperation).doConstruct(args) as Promise<T>,
            result => result);
    },
    async constructFrom<T extends Entity, F extends Entity>(entity: F, symbol: ConstructSymbol<T, From<F>>, ...args: unknown[]): Promise<T> {
        await OperationLogic.assertOperationAllowed(symbol, entity.constructor, false, entity);
        return await logOperation(symbol, entity,
            () => (find(symbol, OperationType.ConstructorFrom) as IConstructorFromOperation).doConstructFrom(entity, args) as Promise<T>,
            result => result);
    },
    async constructFromMany<T extends Entity, F extends Entity>(lites: Lite<F>[], symbol: ConstructSymbol<T, FromMany<F>>, ...args: unknown[]): Promise<T> {
        return await logOperation(symbol, null,
            () => (find(symbol, OperationType.ConstructorFromMany) as IConstructorFromManyOperation).doConstructFromMany(lites as Lite<Entity>[], args) as Promise<T>,
            result => result);
    },
    // The button-state check (Signum's entity.CanExecute(symbol)).
    canExecute<T extends Entity>(entity: T, symbol: ExecuteSymbol<T> | DeleteSymbol<T>): string | null {
        return (OperationLogic.findOperation(symbol) as IEntityOperation).onCanExecute(entity);
    },
};
