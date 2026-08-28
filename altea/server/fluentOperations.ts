import type { Quoted } from "quote-transformer/quoted";
import type { Entity, Type } from "../data/entity";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../data/operations";
import { FluentInclude } from "./schema/fluentInclude";
import { Graph } from "./graph";
import { tryStateEnum } from "./operation";
import type {
    OptionalBody,
    ExecuteOptions, DeleteOptions,
    ConstructOptions, ConstructFromOptions, ConstructFromManyOptions,
    ExecuteOptionsWithState, DeleteOptionsWithState,
    ConstructOptionsWithState, ConstructFromOptionsWithState, ConstructFromManyOptionsWithState,
} from "./graph";
import "./index"; // installs Entity.save() / Entity.delete() (the default withSave / withDelete bodies)

// Port of Signum's `FluentOperationInclude` (Operations/OperationLogic.cs) — its `WithSave` / `WithDelete`
// extension methods on FluentInclude<T> — WIDENED to cover every operation kind, so a type's whole
// operation surface is declared where the type is included:
//
//     sb.include(OrderEntity)
//         .withQuery()
//         .withConstructFrom(CustomerEntity, OrderOperation.CreateOrderFromCustomer, { construct })
//         .withStateMachine(o => o.state, sm => {
//             sm.withSave(OrderOperation.Save, { fromStates: […], toStates: […], execute })
//               .withExecute(OrderOperation.Ship, { fromStates: […], toStates: […], execute })
//               .withDelete(OrderOperation.Delete, { fromStates: […] });
//         });
//
// This REPLACES the `graph(Order, OrderState, g => { g.GetState = …; g.Execute(sym, …) })` sugar altea
// used to carry (server/graphBuilder.ts, deleted). Four things are better here:
//   - **the verbs say "register"**. `g.Construct(sym, …)` reads as "construct something", when what it
//     does is declare an operation; `withConstruct` cannot be misread.
//   - **the state selector types the states**. `withStateMachine(o => o.state, …)` infers S from the
//     selector, so the separate `OrderState` argument `graph(T, StateEnum, …)` needed is gone. And the
//     two surfaces are SEPARATE types: `fromStates` / `toStates` exist only on {@link FluentStateMachine},
//     so writing one where no state machine is open is a compile error rather than an unchecked option.
//     Signum can express neither half: its `Graph<T>` / `Graph<T, S>` are two hierarchies picked by hand.
//   - **there is no second registration step**. A `graph(…)` was a declared const whose `register()` had
//     to be called from `start`, and forgetting it silently dropped every operation it held (which is
//     exactly what happened to two altea-dynamic graphs). Here the include IS the registration.
//   - **a big graph can still live outside `start`**. Both `withStateMachine` and `withOperations` take a
//     plain callback, so the whole thing can be a named function — `.withStateMachine(o => o.state,
//     registerOrderOperations)` — which is what Signum's separate `OrderGraph` class bought, without the
//     class or the registration call. Inside such a function, {@link FluentStateMachine.parent} is how the
//     type's STATELESS operations are reached, so one function can still declare the whole surface.
//
// The methods are added to FluentInclude by declaration merging + prototype augmentation, exactly like
// DynamicQueryFluentInclude.withQuery (dynamicQuery/fluentIncludeQuery.ts) — kept in the operations
// layer so the schema layer stays independent of operations. Importing this module installs them.
//
// For full control over one operation — inspecting it, mutating it later, re-registering it with
// `replace` — skip this and use the `new Graph.Execute(Order, sym, { … })` classes directly (./graph).

/**
 * The operation-registration surface of a type, with NO state machine open: it IS `FluentInclude<T>`, so
 * every `sb.include(X)` has these methods — and `sb.include` is idempotent, so a type another module
 * included (or one known only at runtime) is reached the same way. Every method registers its operation
 * immediately and returns `this`, so the calls chain.
 */
export interface FluentOperations<T extends Entity> {
    /** The type the operations are registered for — Signum's erased `Graph<T>` generic, as a value. */
    readonly type: Type<T>;

    /**
     * Signum's `WithSave(saveOperation)`: the plain Save Execute — `canBeNew` and `canBeModified` default
     * to true and the body to a no-op, since the operation's implicit save is what persists the entity.
     * Pass `execute` to run extra logic on save (eastwind's `EmployeeOperation.Save`).
     */
    withSave(symbol: ExecuteSymbol<T>, options?: OptionalBody<ExecuteOptions<T>, "execute">): this;
    /** Signum's `WithDelete(deleteOperation)`: a Delete whose body defaults to `entity.delete()` (the set-based single-row delete installed by server/index.ts). */
    withDelete(symbol: DeleteSymbol<T>, options?: OptionalBody<DeleteOptions<T>, "delete">): this;
    /** An arbitrary Execute on this type (Signum's `Graph<T>.Execute`). */
    withExecute(symbol: ExecuteSymbol<T>, options: ExecuteOptions<T>): this;
    /**
     * A parameterless constructor (Signum's `Graph<T>.Construct`), invoked from this type's frame — so the
     * OWNER is this type even for the rare `Construct<R>` that builds a different R, which is where
     * Signum's `Graph<T>.Construct` puts it too (`OverridenType => typeof(T)`). The body defaults to
     * `T.create({})`, the blank instance a "Create" button almost always means.
     */
    withConstruct<R extends Entity>(symbol: ConstructSymbol<R>, options?: OptionalBody<ConstructOptions<R>, "construct">): this;
    /**
     * Build R from ONE source F (Signum's `Graph<T>.ConstructFrom<F>`). `fromType` is not boilerplate: the
     * owner of a ConstructFrom is the SOURCE type — that is the frame whose button appears — and F is
     * erased, so nothing around the call can supply it (see graph.ts).
     */
    withConstructFrom<R extends Entity, F extends Entity>(fromType: Type<F>, symbol: ConstructSymbol<R, From<F>>, options: ConstructFromOptions<R, F>): this;
    /** Build R from MANY source lites (Signum's `Graph<T>.ConstructFromMany<F>`); `fromType` as above. */
    withConstructFromMany<R extends Entity, F extends Entity>(fromType: Type<F>, symbol: ConstructSymbol<R, FromMany<F>>, options: ConstructFromManyOptions<R, F>): this;

    /**
     * Open a STATE MACHINE over `getState` (Signum's `Graph<T, S>.GetState`): every operation the callback
     * declares gets that selector stamped on it, so its `fromStates` / `toStates` are checked — and typed,
     * since S is inferred from the selector's return type.
     *
     * The selector is `Quoted` because Signum's is an `Expression<Func<T, S>>`, not a delegate: besides
     * being CALLED (the state checks), it is read as a TREE — @altea/altea-map's operation map groups the
     * type's rows by it to count each state's population, and turns the same member list into the query
     * token the state node's Ctrl+Click filters by.
     */
    withStateMachine<S>(getState: Quoted<(entity: T) => S>, define: (sm: FluentStateMachine<T, S>) => void): this;
    /**
     * Declare this type's operations in a block — the callback receives `this`, so it registers exactly
     * what the flat chain would. Two reasons to use it: the include also carries indexes / queries /
     * caching and the operations would be lost in the same chain, or the block is a NAMED FUNCTION, which
     * is how a large graph is kept out of `start` (Signum's separate `XGraph` class, minus the class).
     */
    withOperations(define: (ops: FluentOperations<T>) => void): this;
}

/**
 * {@link FluentOperations} with a state machine bound — the surface `withStateMachine` hands its callback.
 * Same methods, except that every option object now carries `fromStates` / `toStates` typed as S, and the
 * selector is stamped onto each operation for you (Signum's `Graph<T, S>`).
 */
export interface FluentStateMachine<T extends Entity, S> {
    /** The type the operations are registered for. */
    readonly type: Type<T>;
    /** The state selector stamped onto every operation declared here. */
    readonly getState: Quoted<(entity: T) => S>;
    /**
     * The enum S's members belong to, stamped onto every operation declared here alongside the selector
     * — altea's stand-in for Signum's `IOperation.StateType`, which `Graph<T, S>` reads straight off S.
     * Resolved ONCE here, from the selector's property route, so no state error and no contextual
     * can-execute has to walk it again.
     */
    readonly stateEnum: object | undefined;
    /**
     * The stateless surface this state machine was opened from — the `FluentInclude<T>` itself.
     * It is what makes an EXTRACTED graph function complete: a type's Create / Clone / plain Save have no
     * state to check, and `sm.parent.withConstruct(…)` declares them without going back to `start`.
     */
    readonly parent: FluentOperations<T>;

    // The options are no longer optional on the three methods whose BODY has a default: their state
    // guards do not, so there is always something to pass. An operation of this type that genuinely has
    // no state — a plain Create, a Save with no transition — belongs on {@link parent}.
    /** As {@link FluentOperations.withSave}, plus the required `fromStates` / `toStates`. */
    withSave(symbol: ExecuteSymbol<T>, options: OptionalBody<ExecuteOptionsWithState<T, S>, "execute">): this;
    /** As {@link FluentOperations.withDelete}, plus the required `fromStates`. */
    withDelete(symbol: DeleteSymbol<T>, options: OptionalBody<DeleteOptionsWithState<T, S>, "delete">): this;
    /** As {@link FluentOperations.withExecute}, plus the required `fromStates` / `toStates`. */
    withExecute(symbol: ExecuteSymbol<T>, options: ExecuteOptionsWithState<T, S>): this;
    /** As {@link FluentOperations.withConstruct}, plus the required `toStates`. */
    withConstruct<R extends Entity>(symbol: ConstructSymbol<R>, options: OptionalBody<ConstructOptionsWithState<R, S>, "construct">): this;
    /** As {@link FluentOperations.withConstructFrom}, plus the required `toStates`. */
    withConstructFrom<R extends Entity, F extends Entity>(fromType: Type<F>, symbol: ConstructSymbol<R, From<F>>, options: ConstructFromOptionsWithState<R, F, S>): this;
    /** As {@link FluentOperations.withConstructFromMany}, plus the required `toStates`. */
    withConstructFromMany<R extends Entity, F extends Entity>(fromType: Type<F>, symbol: ConstructSymbol<R, FromMany<F>>, options: ConstructFromManyOptionsWithState<R, F, S>): this;
    /** As {@link FluentOperations.withOperations} — a block, or a named function, over this state machine. */
    withOperations(define: (ops: FluentStateMachine<T, S>) => void): this;
}

// `this` inside the shared method bodies. Both public surfaces are typed views of the SAME object, and
// these members are all a body reads off it: the type it registers for and — inside a state machine — the
// selector and the enum to stamp. Derived from FluentOperations rather than restated, so there is no
// second description of the same thing; both are optional because the stateless view has neither.
type OperationsThis<T extends Entity, S> = Pick<FluentOperations<T>, "type"> & {
    readonly getState?: Quoted<(entity: T) => S>;
    readonly stateEnum?: object;
};

// `Entity.create` narrows `this` to `new () => T` (a factory cannot be abstract-tolerant) while a
// `Type<T>` is abstract-tolerant, hence the cast; every entity constructor inherits the static. It must
// be `create({})` and not `new type()`: a mixin's field initializers only run in the factory.
function createBlank<T extends Entity>(type: Type<T>): T {
    return (type as unknown as { create(values: object): T }).create({});
}

// The method bodies, written once and installed on both hosts (FluentInclude and the StateMachineBuilder)
// so neither carries a copy. `this` is the host; every method registers its operation and returns it.
//
// Each spreads `...options` LAST, so a caller's own `getState` / `execute` / `construct` wins over the
// state machine's selector and over the defaulted body.
const fluentOperations = {
    withSave<T extends Entity, S>(this: OperationsThis<T, S>, symbol: ExecuteSymbol<T>, options?: Partial<ExecuteOptionsWithState<T, S>>) {
        new Graph.Execute<T, S>(this.type, symbol, {
            canBeNew: true,
            canBeModified: true,
            execute: () => { },
            getState: this.getState,
            stateEnum: this.stateEnum,
            ...options,
        } as ExecuteOptions<T>).register();
        return this;
    },

    withDelete<T extends Entity, S>(this: OperationsThis<T, S>, symbol: DeleteSymbol<T>, options?: Partial<DeleteOptionsWithState<T, S>>) {
        new Graph.Delete<T, S>(this.type, symbol, {
            delete: e => e.delete(),
            getState: this.getState,
            stateEnum: this.stateEnum,
            ...options,
        } as DeleteOptions<T>).register();
        return this;
    },

    withExecute<T extends Entity, S>(this: OperationsThis<T, S>, symbol: ExecuteSymbol<T>, options: Partial<ExecuteOptionsWithState<T, S>>) {
        new Graph.Execute<T, S>(this.type, symbol, { getState: this.getState, stateEnum: this.stateEnum, ...options } as ExecuteOptions<T>).register();
        return this;
    },

    withConstruct<T extends Entity, S, R extends Entity>(this: OperationsThis<T, S>, symbol: ConstructSymbol<R>, options?: Partial<ConstructOptionsWithState<R, S>>) {
        // The owner is THIS type (see the interface doc), which is why it is cast: `Graph.Construct<R>`
        // declares `entityType: Type<R>`. The same R-vs-T gap makes the state selector — typed over T — a
        // `(entity: R) => S` here. R and T coincide for every Construct in the workspace; the two casts
        // are the price of allowing the rare cross-type one at all, as Signum's Graph<T> does.
        new Graph.Construct<R, S>(this.type as never, symbol, {
            construct: () => createBlank(this.type) as unknown as R,
            getState: this.getState as unknown as Quoted<(entity: R) => S> | undefined,
            stateEnum: this.stateEnum,
            ...options,
        } as ConstructOptions<R>).register();
        return this;
    },

    withConstructFrom<T extends Entity, S, R extends Entity, F extends Entity>(this: OperationsThis<T, S>, fromType: Type<F>, symbol: ConstructSymbol<R, From<F>>, options: Partial<ConstructFromOptionsWithState<R, F, S>>) {
        new Graph.ConstructFrom<R, F, S>(fromType, symbol, {
            getState: this.getState as unknown as Quoted<(entity: R) => S> | undefined,
            stateEnum: this.stateEnum,
            ...options,
        } as ConstructFromOptions<R, F>).register();
        return this;
    },

    withConstructFromMany<T extends Entity, S, R extends Entity, F extends Entity>(this: OperationsThis<T, S>, fromType: Type<F>, symbol: ConstructSymbol<R, FromMany<F>>, options: Partial<ConstructFromManyOptionsWithState<R, F, S>>) {
        new Graph.ConstructFromMany<R, F, S>(fromType, symbol, {
            getState: this.getState as unknown as Quoted<(entity: R) => S> | undefined,
            stateEnum: this.stateEnum,
            ...options,
        } as ConstructFromManyOptions<R, F>).register();
        return this;
    },

    withStateMachine<T extends Entity, S2>(this: Pick<FluentOperations<T>, "type">, getState: Quoted<(entity: T) => S2>, define: (sm: FluentStateMachine<T, S2>) => void) {
        define(new StateMachineBuilder<T, S2>(this.type, getState, this as FluentOperations<T>));
        return this;
    },

    withOperations<T extends Entity, S>(this: OperationsThis<T, S>, define: (ops: never) => void) {
        // The callback gets `this`: the stateless surface declares the parameter as FluentOperations<T>,
        // the state machine as FluentStateMachine<T, S>, and either way it is this same object.
        define(this as never);
        return this;
    },
};

// The host `withStateMachine` hands its callback.
class StateMachineBuilder<T extends Entity, S> {
    /** Resolved once for the whole block — see {@link FluentStateMachine.stateEnum}. */
    readonly stateEnum: object | undefined;
    constructor(
        readonly type: Type<T>,
        readonly getState: Quoted<(entity: T) => S>,
        readonly parent: FluentOperations<T>,
    ) {
        this.stateEnum = tryStateEnum(type, getState);
    }
}
interface StateMachineBuilder<T extends Entity, S> extends FluentStateMachine<T, S> { }
Object.assign(StateMachineBuilder.prototype, fluentOperations);

declare module "./schema/fluentInclude" {
    // The whole operation surface, with no state machine open — so `fromStates` / `toStates` are not part
    // of the option objects until `withStateMachine` binds an S.
    interface FluentInclude<T extends Entity> extends FluentOperations<T> { }
}
Object.assign(FluentInclude.prototype, fluentOperations);
