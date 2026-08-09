import { Entity } from "../data/entity";
import type { Lite } from "../data/lite";
import { OperationSymbol } from "../data/operations";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../data/operations";
import { OperationLogEntity } from "../data/operationLog";
import { Temporal } from "../data/basics";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import { SymbolLogic } from "./symbolLogic";
import { Saver } from "./saver";
import { ExceptionLogic } from "./exceptionLogic";
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
// (type,symbol)) — one impl per symbol, no operation inheritance — which is all Southwind
// needs and avoids needing entity ctors at registration (the typed containers carry the
// entity type only as an erased phantom).

const operations = new Map<OperationSymbol, IOperation>();

export namespace OperationLogic {
    // Signum's OperationLogic.Register(replace). Validates the operation, then stores it
    // by symbol. `replace` allows an external module to swap an operation's impl.
    export function register(operation: IOperation, replace = false): void {
        if (!replace && operations.has(operation.operationSymbol))
            throw new Error(`Operation '${operation.operationSymbol.key}' has already been registered (pass replace=true to override).`);
        operation.assertIsValid();
        operations.set(operation.operationSymbol, operation);
    }

    // Remove an operation entirely (so it can be re-registered differently, or dropped).
    export function unregister(symbol: OperationSymbol): boolean {
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
        return await logOperation(symbol, null,
            () => (find(symbol, OperationType.Execute) as IExecuteOperation).doExecute(entity, args) as Promise<T>,
            result => result);
    },
    async delete<T extends Entity>(entity: T, symbol: DeleteSymbol<T>, ...args: unknown[]): Promise<void> {
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
