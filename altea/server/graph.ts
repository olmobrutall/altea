import type { Entity, EntityType } from "../data/entity";
import type { Lite } from "../data/lite";
import type { OperationSymbol } from "../data/operations";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../data/operations";
import { Transaction } from "./connection/transaction";
import {
    OperationType,
    type IExecuteOperation, type IDeleteOperation, type IConstructOperation,
    type IConstructorFromOperation, type IConstructorFromManyOperation,
} from "./operation";
import { OperationLogic } from "./operationLogic";
import { HeavyProfiler } from "./profiler/heavyProfiler";

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
//
// Each op takes its config as a second constructor argument (Signum's C# object-initializer
// `new Graph<T>.Execute(sym) { CanBeNew = true, … }` has no TS equivalent, so the options object
// stands in for it): `new Graph.Execute(sym, { execute, canBeNew: true })`. The constructor
// Object.assigns them onto the instance, so callers never Object.assign themselves.

// ---- Option objects (the second constructor arg of each Graph.* op) ---------------------------
// Every field is the matching class field; all but the primary callback (`construct`/`execute`/
// `delete`) and `entityType` are optional. `getState` may be set here per-op, or once for a whole
// graph via GraphBuilder.GetState (graphBuilder.ts stamps it onto ops that didn't set their own).
//
// `entityType` is the entity this operation is REGISTERED ON — the type whose frame shows its button, and
// the key it is shipped under in the reflection metadata blob (Signum's `OverridenType`). A generic
// parameter is erased at runtime, so `Graph.Execute<T>` cannot recover T on its own; it has to be told,
// or the runtime is back to guessing the owner by splitting the symbol key ("OrderOperation.Ship" →
// "OrderEntity") — which silently loses every operation whose container is not named after its type.
//
// But it is almost never written by hand, because the surrounding registration already names the type:
//   - inside `graph(OrderEntity, …)` every builder fills it in from the graph's own type;
//   - `withSave` / `withDelete` fill it from the type the include was opened for.
// So write it only where the owner genuinely differs from that context:
//   - **ConstructFrom / ConstructFromMany**, whose owner is the SOURCE type F (that is where the button
//     appears) — the one thing an enclosing `graph(T, …)` cannot know, since F is erased too;
//   - an operation shared by an ABSTRACT base's implementations (its subclasses inherit it, so ONE
//     registration owned by the base covers them all — see eastwind's CustomerOperation.Save);
//   - an owner that is a TS interface, hence has no constructor at all (see OperationLogic.registerForType).
export interface ConstructOptions<T extends Entity, S = never> {
    entityType?: EntityType<T>;
    construct: (args: unknown[]) => T | Promise<T>;
    toStates?: S[];
    getState?: (entity: T) => S;
}
export interface ConstructFromOptions<T extends Entity, F extends Entity, S = never> {
    /** The SOURCE type F (where the button appears), not the constructed T. */
    entityType: EntityType<F>;
    construct: (from: F, args: unknown[]) => T | Promise<T>;
    canConstruct?: (from: F) => string | null;
    canBeNew?: boolean;
    canBeModified?: boolean;
    resultIsSaved?: boolean;
    toStates?: S[];
    getState?: (entity: T) => S;
}
export interface ConstructFromManyOptions<T extends Entity, F extends Entity, S = never> {
    /** The SOURCE type F (where the button appears), not the constructed T. */
    entityType: EntityType<F>;
    construct: (lites: Lite<F>[], args: unknown[]) => T | Promise<T>;
    toStates?: S[];
    getState?: (entity: T) => S;
}
export interface ExecuteOptions<T extends Entity, S = never> {
    entityType?: EntityType<T>;
    execute: (entity: T, args: unknown[]) => void | Promise<void>;
    canExecute?: (entity: T) => string | null;
    canBeNew?: boolean;
    canBeModified?: boolean;
    avoidImplicitSave?: boolean;
    fromStates?: S[];
    toStates?: S[];
    getState?: (entity: T) => S;
}
export interface DeleteOptions<T extends Entity, S = never> {
    entityType?: EntityType<T>;
    delete: (entity: T, args: unknown[]) => void | Promise<void>;
    canDelete?: (entity: T) => string | null;
    fromStates?: S[];
    getState?: (entity: T) => S;
}

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
        entityType!: EntityType<T>;
        construct!: (args: unknown[]) => T | Promise<T>;
        toStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: ConstructSymbol<T>, options: ConstructOptions<T, S>) { Object.assign(this, options); }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        async doConstruct(args: unknown[]): Promise<Entity> {
            // Profiler span (Signum's Graph.cs HeavyProfiler.Log). `await` so it covers the transaction.
            using _prof = HeavyProfiler.log("Construct", () => this.symbol.key);
            return await Transaction.create(async () => {
                const result = await this.construct(args);
                assertToStates(result, this.toStates, this.getState);
                return result as Entity;
            });
        }
        assertIsValid(): void {
            if (this.entityType == null) throw new Error(`Operation '${this.symbol.key}' has no entityType.`);
            if (this.construct == null) throw new Error(`Operation '${this.symbol.key}' has no construct.`);
            if (this.toStates != null && this.getState == null) throw new Error(`Operation '${this.symbol.key}' has toStates but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }

    // Signum's Graph<T>.ConstructFrom<F> — build T from one source F.
    export class ConstructFrom<T extends Entity, F extends Entity, S = never> implements IConstructorFromOperation {
        readonly operationType = OperationType.ConstructorFrom;
        entityType!: EntityType<F>;
        construct!: (from: F, args: unknown[]) => T | Promise<T>;
        canConstruct?: (from: F) => string | null;
        canBeNew = false;
        canBeModified = false;
        resultIsSaved = false;
        toStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: ConstructSymbol<T, From<F>>, options: ConstructFromOptions<T, F, S>) { Object.assign(this, options); }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        onCanExecute(from: F): string | null {
            if (from.isNew && !this.canBeNew) return isNewError;
            return this.canConstruct != null ? this.canConstruct(from) : null;
        }
        async doConstructFrom(from: F, args: unknown[]): Promise<Entity> {
            using _prof = HeavyProfiler.log("ConstructFrom", () => `${this.symbol.key} on ${from}`);
            return await Transaction.create(async () => {
                const error = this.onCanExecute(from);
                if (error != null) throw new Error(error);
                const result = await this.construct(from, args);
                assertToStates(result, this.toStates, this.getState);
                return result as Entity;
            });
        }
        assertIsValid(): void {
            if (this.entityType == null) throw new Error(`Operation '${this.symbol.key}' has no entityType.`);
            if (this.construct == null) throw new Error(`Operation '${this.symbol.key}' has no construct.`);
            if (this.toStates != null && this.getState == null) throw new Error(`Operation '${this.symbol.key}' has toStates but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }

    // Signum's Graph<T>.ConstructFromMany<F> — build T from many source lites.
    export class ConstructFromMany<T extends Entity, F extends Entity, S = never> implements IConstructorFromManyOperation {
        readonly operationType = OperationType.ConstructorFromMany;
        entityType!: EntityType<F>;
        construct!: (lites: Lite<F>[], args: unknown[]) => T | Promise<T>;
        toStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: ConstructSymbol<T, FromMany<F>>, options: ConstructFromManyOptions<T, F, S>) { Object.assign(this, options); }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        async doConstructFromMany(lites: Lite<Entity>[], args: unknown[]): Promise<Entity> {
            using _prof = HeavyProfiler.log("ConstructFromMany", () => this.symbol.key);
            return await Transaction.create(async () => {
                const result = await this.construct(lites as Lite<F>[], args);
                assertToStates(result, this.toStates, this.getState);
                return result as Entity;
            });
        }
        assertIsValid(): void {
            if (this.entityType == null) throw new Error(`Operation '${this.symbol.key}' has no entityType.`);
            if (this.construct == null) throw new Error(`Operation '${this.symbol.key}' has no construct.`);
            if (this.toStates != null && this.getState == null) throw new Error(`Operation '${this.symbol.key}' has toStates but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }

    // Signum's Graph<T>.Execute / Graph<T,S>.Execute.
    export class Execute<T extends Entity, S = never> implements IExecuteOperation {
        readonly operationType = OperationType.Execute;
        entityType!: EntityType<T>;
        execute!: (entity: T, args: unknown[]) => void | Promise<void>;
        canExecute?: (entity: T) => string | null;
        canBeNew = false;
        canBeModified = false;
        avoidImplicitSave = false;
        fromStates?: S[];
        toStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: ExecuteSymbol<T>, options: ExecuteOptions<T, S>) { Object.assign(this, options); }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        onCanExecute(entity: T): string | null {
            if (entity.isNew && !this.canBeNew) return isNewError;
            if (this.fromStates != null && this.getState != null && !this.fromStates.includes(this.getState(entity)))
                return stateError(this.getState(entity), this.fromStates);
            return this.canExecute != null ? this.canExecute(entity) : null;
        }
        async doExecute(entity: T, args: unknown[]): Promise<Entity> {
            using _prof = HeavyProfiler.log("Execute", () => `${this.symbol.key} on ${entity}`);
            return await Transaction.create(async () => {
                const error = this.onCanExecute(entity);
                if (error != null) throw new Error(error);
                await this.execute(entity, args);
                assertToStates(entity, this.toStates, this.getState);
                if (!this.avoidImplicitSave) await entity.save(); // nothing happens if already saved
                return entity as Entity;
            });
        }
        assertIsValid(): void {
            if (this.entityType == null) throw new Error(`Operation '${this.symbol.key}' has no entityType.`);
            if (this.execute == null) throw new Error(`Operation '${this.symbol.key}' has no execute.`);
            if ((this.fromStates != null || this.toStates != null) && this.getState == null)
                throw new Error(`Operation '${this.symbol.key}' has states but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }

    // Signum's Graph<T>.Delete / Graph<T,S>.Delete.
    export class Delete<T extends Entity, S = never> implements IDeleteOperation {
        readonly operationType = OperationType.Delete;
        entityType!: EntityType<T>;
        delete!: (entity: T, args: unknown[]) => void | Promise<void>;
        canDelete?: (entity: T) => string | null;
        readonly canBeNew = false;
        readonly canBeModified = false;
        fromStates?: S[];
        getState?: (entity: T) => S;
        constructor(readonly symbol: DeleteSymbol<T>, options: DeleteOptions<T, S>) { Object.assign(this, options); }
        get operationSymbol(): OperationSymbol { return this.symbol; }

        onCanExecute(entity: T): string | null {
            if (entity.isNew) return isNewError;
            if (this.fromStates != null && this.getState != null && !this.fromStates.includes(this.getState(entity)))
                return stateError(this.getState(entity), this.fromStates);
            return this.canDelete != null ? this.canDelete(entity) : null;
        }
        async doDelete(entity: T, args: unknown[]): Promise<void> {
            using _prof = HeavyProfiler.log("Delete", () => `${this.symbol.key} on ${entity}`);
            await Transaction.create(async () => {
                const error = this.onCanExecute(entity);
                if (error != null) throw new Error(error);
                await this.delete(entity, args);
            });
        }
        assertIsValid(): void {
            if (this.entityType == null) throw new Error(`Operation '${this.symbol.key}' has no entityType.`);
            if (this.delete == null) throw new Error(`Operation '${this.symbol.key}' has no delete.`);
            if (this.fromStates != null && this.getState == null) throw new Error(`Operation '${this.symbol.key}' has fromStates but no getState.`);
        }
        register(replace = false): this { OperationLogic.register(this, replace); return this; }
    }
}
