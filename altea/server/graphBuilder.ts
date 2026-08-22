import type { Entity, Type } from "../data/entity";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../data/operations";
import { Graph } from "./graph";
import type {
    ExecuteOptions, DeleteOptions,
    ConstructOptions, ConstructFromOptions, ConstructFromManyOptions,
} from "./graph";

// `graph(Order, OrderState, g => { g.GetState = o => o.state; g.Execute(sym, { … }); … })`
// — sugar over the Graph.* operation classes (./graph): news each up with T (and S) bound and with the
// graph's type as the operation's owner, so neither is repeated per operation, stamps the graph's
// GetState onto each, and registers them all on register(). For full control, skip this and use the
// `new Graph.Execute(Order, sym, { … })` classes directly.

// The option objects are re-exported from ./graph (co-located with the op classes they configure).
export type {
    ExecuteOptions, DeleteOptions,
    ConstructOptions, ConstructFromOptions, ConstructFromManyOptions,
} from "./graph";

export interface GraphBuilder<T extends Entity, S> {
    // Set once (Signum's `GetState = o => o.State`). graph() stamps it onto every op.
    GetState?: (entity: T) => S;
    // The methods mirror Signum's Graph<T>.Execute / .Delete / .Construct / … class names
    // (PascalCase): each news up the matching Graph.* operation class with T (and S) bound, passing the
    // graph's own type as the operation's owner — so the type argument the classes take is never repeated
    // here. The two ConstructFrom* builders are the exception: their owner is the SOURCE type, which is
    // erased and therefore not something the graph can know, so they take it FIRST (see graph.ts).
    Execute(symbol: ExecuteSymbol<T>, options: ExecuteOptions<T, S>): Graph.Execute<T, S>;
    Delete(symbol: DeleteSymbol<T>, options: DeleteOptions<T, S>): Graph.Delete<T, S>;
    Construct<R extends Entity>(symbol: ConstructSymbol<R>, options: ConstructOptions<R, S>): Graph.Construct<R, S>;
    ConstructFrom<R extends Entity, F extends Entity>(fromType: Type<F>, symbol: ConstructSymbol<R, From<F>>, options: ConstructFromOptions<R, F, S>): Graph.ConstructFrom<R, F, S>;
    ConstructFromMany<R extends Entity, F extends Entity>(fromType: Type<F>, symbol: ConstructSymbol<R, FromMany<F>>, options: ConstructFromManyOptions<R, F, S>): Graph.ConstructFromMany<R, F, S>;
}

export interface GraphRegistration {
    // The operations collected by the callback (for inspection / manual tweaking).
    readonly operations: readonly { register(replace?: boolean): unknown; getState?: unknown }[];
    // Stamps getState onto each op (Signum's shared GetState) and registers them all.
    register(): void;
}

export function graph<T extends Entity>(type: Type<T>, define: (g: GraphBuilder<T, never>) => void): GraphRegistration;
export function graph<T extends Entity, E extends object>(type: Type<T>, stateEnum: E, define: (g: GraphBuilder<T, E[keyof E]>) => void): GraphRegistration;
export function graph<T extends Entity>(
    type: Type<T>,
    defineOrEnum: unknown,
    maybeDefine?: (g: GraphBuilder<T, any>) => void,
): GraphRegistration {
    const define = (maybeDefine ?? defineOrEnum) as (g: GraphBuilder<T, any>) => void;

    const collected: { register(replace?: boolean): unknown; getState?: unknown }[] = [];
    const collect = <O extends { register(replace?: boolean): unknown; getState?: unknown }>(op: O): O => {
        collected.push(op);
        return op;
    };

    const g: GraphBuilder<T, any> = {
        GetState: undefined,
        // Execute / Delete / Construct are registered on the graph's OWN type, so the owner argument is
        // the graph's `type` and is never written per operation. (A `Construct<R>` that builds a DIFFERENT type is still
        // *invoked* from this type's frame, which is where Signum's `Graph<T>.Construct<R>` puts it too.)
        // ConstructFrom(Many) is the exception: its owner is the SOURCE type, erased and unknowable here.
        Execute: (symbol, options) => collect(new Graph.Execute<T, any>(type, symbol, options)),
        Delete: (symbol, options) => collect(new Graph.Delete<T, any>(type, symbol, options)),
        // The cast bridges the R-vs-T gap: a `Construct<R>` may build a DIFFERENT type than the graph's,
        // but it is still INVOKED from this type's frame — which is exactly where Signum's
        // `Graph<T>.Construct` owns it (`OverridenType => typeof(T)`). So the owner is `type`, not R.
        Construct: (symbol, options) => collect(new Graph.Construct(type as never, symbol, options)),
        ConstructFrom: (fromType, symbol, options) => collect(new Graph.ConstructFrom(fromType, symbol, options)),
        ConstructFromMany: (fromType, symbol, options) => collect(new Graph.ConstructFromMany(fromType, symbol, options)),
    };
    define(g);

    return {
        operations: collected,
        register() {
            for (const op of collected) {
                // Stamp the graph's GetState onto each op's (internal) getState field.
                if (g.GetState != null && "getState" in op && op.getState == null)
                    (op as { getState?: unknown }).getState = g.GetState;
                op.register();
            }
        },
    };
}
