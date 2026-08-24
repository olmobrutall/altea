import type { Quoted } from "quote-transformer/quoted";
import type { Entity, Type } from "../data/entity";
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
// State (S) is optional (Graph<T> vs Graph<T,S>) via a per-op `getState: Quoted<(t) => S>` +
// from/to states, unified into one class instead of Signum's two hierarchies. Each op
// runs in Transaction.create. Deferred: authorization, OperationLogEntity logging.
//
// `getState` is QUOTED because Signum's is an `Expression<Func<T, S>>`: besides being CALLED (the
// from/to state checks below), it is read as a TREE by Signum.Map, which groups the type's rows by it
// to count each state's population and derives the state's query token from the same member list.
// `Quoted<F>` is `F & { __quoted?: … }`, so nothing about the in-memory calls changes — the transformer
// just stamps the tree beside the lambda. The reader is `IGraphStateOperation` (./operation).
//
// The fluent sugar that news these up with T (and S) bound — `sb.include(Order).withExecute(sym, { … })`,
// `.withStateMachine(o => o.state, sm => …)` — lives in ./fluentOperations, and is how they are normally
// written; reach for the classes directly when one operation has to be held, mutated or re-registered.
//
// Each op takes its config as a second constructor argument (Signum's C# object-initializer
// `new Graph<T>.Execute(sym) { CanBeNew = true, … }` has no TS equivalent, so the options object
// stands in for it): `new Graph.Execute(sym, { execute, canBeNew: true })`. The constructor
// Object.assigns them onto the instance, so callers never Object.assign themselves.

// ---- Option objects (the third constructor arg of each Graph.* op) ----------------------------
// Every field is the matching class field.
//
// The OWNING TYPE is not one of them: it is the FIRST constructor argument — `new Graph.Execute(
// OrderEntity, OrderOperation.Ship, { … })`. It stands in for the erased generic: Signum writes
// `new Graph<OrderEntity>.Execute(sym)` and reads T back through reflection, which TypeScript cannot do,
// and the alternative is guessing the owner by splitting the symbol key ("OrderOperation.Ship" →
// "OrderEntity"), which silently loses every operation whose container is not named after its type. It is
// the type whose frame shows the button, and the key the operation is shipped under in the reflection
// metadata blob (Signum's `OverridenType`). As an ARGUMENT rather than an option it cannot be forgotten,
// and it reads in the same position as the include it hangs off.
//
// It is still rarely written by hand, because the surrounding registration already names the type and
// passes it for you: every `sb.include(OrderEntity).with*` method uses the type the include was opened
// for. What stays explicit is what that cannot know:
//   - **ConstructFrom / ConstructFromMany**, whose owner is the SOURCE type F (that is where the button
//     appears) — erased too, so the enclosing include cannot supply it:
//     `.withConstructFrom(CustomerEntity, OrderOperation.CreateOrderFromCustomer, { … })`;
//   - an operation shared by an ABSTRACT base's implementations (its subclasses inherit it, so ONE
//     registration owned by the base covers them all — see eastwind's CustomerOperation.Save). That is
//     why `Type<T>` accepts an abstract constructor;
//   - an owner that is a TS interface, hence has no constructor at all (see OperationLogic.registerForType).
// Each kind comes in TWO shapes: the plain one, for an operation with no state machine over it, and a
// `…WithState` one that adds the state guards. Which one a caller sees is decided by where they are —
// `sb.include(X).withExecute(…)` takes the plain one, `withStateMachine(…, sm => sm.withExecute(…))` the
// stateful one (see ./fluentOperations) — so a `fromStates` written where nothing could check it does not
// compile, and the guards an operation DOES need cannot be forgotten.
//
// That last part is why the state members are REQUIRED rather than optional: Signum asserts exactly these
// at registration time (GraphState.cs `AssertIsValid` — "does not have ToStates initialized" /
// "…FromStates initialized", per operation kind), so the same rule is a type here instead of a throw.
// Which members each kind needs is Signum's table: Construct / ConstructFrom / ConstructFromMany need
// `toStates`, Delete needs `fromStates`, Execute needs both. (Signum's FromToStates alternative for
// Execute is not ported.)
//
// `getState` stays OPTIONAL on all of them, because `withStateMachine` supplies it; it is written by hand
// only when one of the Graph.* classes below is constructed directly.

export interface ConstructOptions<T extends Entity> {
    construct: (args: unknown[]) => T | Promise<T>;
}
export interface ConstructOptionsWithState<T extends Entity, S> extends ConstructOptions<T> {
    toStates: S[];
    getState?: Quoted<(entity: T) => S>;
}

export interface ConstructFromOptions<T extends Entity, F extends Entity> {
    construct: (from: F, args: unknown[]) => T | Promise<T>;
    canConstruct?: (from: F) => string | null;
    canBeNew?: boolean;
    canBeModified?: boolean;
    resultIsSaved?: boolean;
}
export interface ConstructFromOptionsWithState<T extends Entity, F extends Entity, S> extends ConstructFromOptions<T, F> {
    toStates: S[];
    getState?: Quoted<(entity: T) => S>;
}

export interface ConstructFromManyOptions<T extends Entity, F extends Entity> {
    construct: (lites: Lite<F>[], args: unknown[]) => T | Promise<T>;
}
export interface ConstructFromManyOptionsWithState<T extends Entity, F extends Entity, S> extends ConstructFromManyOptions<T, F> {
    toStates: S[];
    getState?: Quoted<(entity: T) => S>;
}

export interface ExecuteOptions<T extends Entity> {
    execute: (entity: T, args: unknown[]) => void | Promise<void>;
    canExecute?: (entity: T) => string | null;
    canBeNew?: boolean;
    canBeModified?: boolean;
    avoidImplicitSave?: boolean;
}
export interface ExecuteOptionsWithState<T extends Entity, S> extends ExecuteOptions<T> {
    fromStates: S[];
    toStates: S[];
    getState?: Quoted<(entity: T) => S>;
}

export interface DeleteOptions<T extends Entity> {
    delete: (entity: T, args: unknown[]) => void | Promise<void>;
    canDelete?: (entity: T) => string | null;
}
export interface DeleteOptionsWithState<T extends Entity, S> extends DeleteOptions<T> {
    fromStates: S[];
    getState?: Quoted<(entity: T) => S>;
}

/**
 * `O` with the members `K` made optional — the option object of a `with*` method whose primary callback
 * has a DEFAULT: `withSave`'s `execute` (a no-op; the implicit save is the point), `withDelete`'s
 * `delete` (`entity.delete()`) and `withConstruct`'s `construct` (`T.create({})`). Nothing else moves —
 * in particular the state guards of a `…WithState` object stay required.
 */
export type OptionalBody<O, K extends keyof O> = Omit<O, K> & Partial<Pick<O, K>>;

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
        getState?: Quoted<(entity: T) => S>;
        constructor(readonly entityType: Type<T>, readonly symbol: ConstructSymbol<T>, options: ConstructOptions<T> | ConstructOptionsWithState<T, S>) { Object.assign(this, options); }
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
        construct!: (from: F, args: unknown[]) => T | Promise<T>;
        canConstruct?: (from: F) => string | null;
        canBeNew = false;
        canBeModified = false;
        resultIsSaved = false;
        toStates?: S[];
        getState?: Quoted<(entity: T) => S>;
        /** `entityType` is the SOURCE type F — where the button appears — not the constructed T. */
        constructor(readonly entityType: Type<F>, readonly symbol: ConstructSymbol<T, From<F>>, options: ConstructFromOptions<T, F> | ConstructFromOptionsWithState<T, F, S>) { Object.assign(this, options); }
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
        construct!: (lites: Lite<F>[], args: unknown[]) => T | Promise<T>;
        toStates?: S[];
        getState?: Quoted<(entity: T) => S>;
        /** `entityType` is the SOURCE type F — where the button appears — not the constructed T. */
        constructor(readonly entityType: Type<F>, readonly symbol: ConstructSymbol<T, FromMany<F>>, options: ConstructFromManyOptions<T, F> | ConstructFromManyOptionsWithState<T, F, S>) { Object.assign(this, options); }
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
        execute!: (entity: T, args: unknown[]) => void | Promise<void>;
        canExecute?: (entity: T) => string | null;
        canBeNew = false;
        canBeModified = false;
        avoidImplicitSave = false;
        fromStates?: S[];
        toStates?: S[];
        getState?: Quoted<(entity: T) => S>;
        constructor(readonly entityType: Type<T>, readonly symbol: ExecuteSymbol<T>, options: ExecuteOptions<T> | ExecuteOptionsWithState<T, S>) { Object.assign(this, options); }
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
        delete!: (entity: T, args: unknown[]) => void | Promise<void>;
        canDelete?: (entity: T) => string | null;
        readonly canBeNew = false;
        readonly canBeModified = false;
        fromStates?: S[];
        getState?: Quoted<(entity: T) => S>;
        constructor(readonly entityType: Type<T>, readonly symbol: DeleteSymbol<T>, options: DeleteOptions<T> | DeleteOptionsWithState<T, S>) { Object.assign(this, options); }
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
