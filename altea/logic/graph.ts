import type { Entity } from "../entities/entity";
import type { Lite } from "../entities/lite";
import type { OperationSymbol } from "../entities/operations";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../entities/operations";
import { Transaction } from "./connection/transaction";
import {
    OperationType,
    type IExecuteOperation, type IDeleteOperation, type IConstructOperation,
    type IConstructorFromOperation, type IConstructorFromManyOperation,
} from "./operation";
import { OperationLogic } from "./operationLogic";

// Port of Signum's Graph<T> / Graph<T, S> (Graph.cs / GraphState.cs). TS can't nest a
// class under a generic (`Graph<T>.Execute`), so the operations are real generic classes
// under a `Graph` namespace — `new Graph.Execute<Order, OrderState>(sym)` — each with the
// same mutable fields as Signum (execute/canExecute/canBeNew/fromStates/toStates/…) plus
// the invoke method. They are first-class: create, configure, `.register()`, and later
// mutate or `OperationLogic.unregister()`/re-`register(replace)` them from anywhere.
//
// State (S) is optional (Graph<T> vs Graph<T,S>) via a per-op `getState: (t) => S` +
// from/to states, unified into one class instead of Signum's two hierarchies. Each op
// runs in Transaction.create. Deferred: authorization, OperationLogEntity logging.
//
// The `graph(...)` sugar that news these up with T/S bound lives in ./graphBuilder.

const isNewError = "The entity is new.";

function stateError<S>(state: S, allowed: S[]): string {
    return `State should be one of [${allowed.map(String).join(", ")}] but was ${String(state)}.`;
}

// After a construct/execute, assert the entity's resulting state is in toStates. Uses the
// op's own state selector; cross-entity constructs (result ≠ T) just omit toStates.
function assertToStates<S>(entity: unknown, toStates: S[] | undefined, getState: ((t: any) => S) | undefined): void {
    if (getState == null || toStates == null)
        return;
    const st = getState(entity);
    if (!toStates.includes(st))
        throw new Error(stateError(st, toStates));
}

export namespace Graph {
    // Signum's Graph<T>.Construct / Graph<T,S>.Construct (result T, optional toStates).
    export class Construct<T extends Entity, S = never> implements IConstructOperation {
        readonly operationType = OperationType.Constructor;
        construct!: (args: unknown[]) => T | Promise<T>;
        toStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: ConstructSymbol<T>) { }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        async doConstruct(args: unknown[]): Promise<Entity> {
            return Transaction.create(async () => {
                const result = await this.construct(args);
                assertToStates(result, this.toStates, this.getState);
                return result as Entity;
            });
        }
        assertIsValid(): void {
            if (this.construct == null) throw new Error(`Operation '${this.symbol.key}' has no construct.`);
            if (this.toStates != null && this.getState == null) throw new Error(`Operation '${this.symbol.key}' has toStates but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }

    // Signum's Graph<T>.ConstructFrom<F> — build T from one source F.
    export class ConstructFrom<T extends Entity, F extends Entity, S = never> implements IConstructorFromOperation {
        readonly operationType = OperationType.ConstructorFrom;
        construct!: (from: F, args: unknown[]) => T | Promise<T>;
        canConstruct?: (from: F) => string | null;
        canBeNew = false;
        canBeModified = false;
        resultIsSaved = false;
        toStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: ConstructSymbol<T, From<F>>) { }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        onCanExecute(from: F): string | null {
            if (from.isNew && !this.canBeNew) return isNewError;
            return this.canConstruct != null ? this.canConstruct(from) : null;
        }
        async doConstructFrom(from: F, args: unknown[]): Promise<Entity> {
            return Transaction.create(async () => {
                const error = this.onCanExecute(from);
                if (error != null) throw new Error(error);
                const result = await this.construct(from, args);
                assertToStates(result, this.toStates, this.getState);
                return result as Entity;
            });
        }
        assertIsValid(): void {
            if (this.construct == null) throw new Error(`Operation '${this.symbol.key}' has no construct.`);
            if (this.toStates != null && this.getState == null) throw new Error(`Operation '${this.symbol.key}' has toStates but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }

    // Signum's Graph<T>.ConstructFromMany<F> — build T from many source lites.
    export class ConstructFromMany<T extends Entity, F extends Entity, S = never> implements IConstructorFromManyOperation {
        readonly operationType = OperationType.ConstructorFromMany;
        construct!: (lites: Lite<F>[], args: unknown[]) => T | Promise<T>;
        toStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: ConstructSymbol<T, FromMany<F>>) { }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        async doConstructFromMany(lites: Lite<Entity>[], args: unknown[]): Promise<Entity> {
            return Transaction.create(async () => {
                const result = await this.construct(lites as Lite<F>[], args);
                assertToStates(result, this.toStates, this.getState);
                return result as Entity;
            });
        }
        assertIsValid(): void {
            if (this.construct == null) throw new Error(`Operation '${this.symbol.key}' has no construct.`);
            if (this.toStates != null && this.getState == null) throw new Error(`Operation '${this.symbol.key}' has toStates but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }

    // Signum's Graph<T>.Execute / Graph<T,S>.Execute.
    export class Execute<T extends Entity, S = never> implements IExecuteOperation {
        readonly operationType = OperationType.Execute;
        execute!: (entity: T, args: unknown[]) => void | Promise<void>;
        canExecute?: (entity: T) => string | null;
        canBeNew = false;
        canBeModified = false;
        avoidImplicitSave = false;
        fromStates?: S[];
        toStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: ExecuteSymbol<T>) { }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        onCanExecute(entity: T): string | null {
            if (entity.isNew && !this.canBeNew) return isNewError;
            if (this.fromStates != null && this.getState != null && !this.fromStates.includes(this.getState(entity)))
                return stateError(this.getState(entity), this.fromStates);
            return this.canExecute != null ? this.canExecute(entity) : null;
        }
        async doExecute(entity: T, args: unknown[]): Promise<Entity> {
            return Transaction.create(async () => {
                const error = this.onCanExecute(entity);
                if (error != null) throw new Error(error);
                await this.execute(entity, args);
                assertToStates(entity, this.toStates, this.getState);
                if (!this.avoidImplicitSave) await entity.save(); // nothing happens if already saved
                return entity as Entity;
            });
        }
        assertIsValid(): void {
            if (this.execute == null) throw new Error(`Operation '${this.symbol.key}' has no execute.`);
            if ((this.fromStates != null || this.toStates != null) && this.getState == null)
                throw new Error(`Operation '${this.symbol.key}' has states but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }

    // Signum's Graph<T>.Delete / Graph<T,S>.Delete.
    export class Delete<T extends Entity, S = never> implements IDeleteOperation {
        readonly operationType = OperationType.Delete;
        delete!: (entity: T, args: unknown[]) => void | Promise<void>;
        canDelete?: (entity: T) => string | null;
        readonly canBeNew = false;
        readonly canBeModified = false;
        fromStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: DeleteSymbol<T>) { }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        onCanExecute(entity: T): string | null {
            if (entity.isNew) return isNewError;
            if (this.fromStates != null && this.getState != null && !this.fromStates.includes(this.getState(entity)))
                return stateError(this.getState(entity), this.fromStates);
            return this.canDelete != null ? this.canDelete(entity) : null;
        }
        async doDelete(entity: T, args: unknown[]): Promise<void> {
            await Transaction.create(async () => {
                const error = this.onCanExecute(entity);
                if (error != null) throw new Error(error);
                await this.delete(entity, args);
            });
        }
        assertIsValid(): void {
            if (this.delete == null) throw new Error(`Operation '${this.symbol.key}' has no delete.`);
            if (this.fromStates != null && this.getState == null) throw new Error(`Operation '${this.symbol.key}' has fromStates but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }
}
