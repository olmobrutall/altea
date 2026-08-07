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
// — sugar over the Graph.* operation classes (./graph): news each up with T (and S) bound
// so they aren't repeated, passing the options straight to the constructor, stamps the
// graph's GetState onto each, and registers them all on register(). For full control, skip
// this and use the `new Graph.Execute(sym, { … })` classes directly.

// The option objects are re-exported from ./graph (co-located with the op classes they configure).
export type {
    ExecuteOptions, DeleteOptions,
    ConstructOptions, ConstructFromOptions, ConstructFromManyOptions,
} from "./graph";

export interface GraphBuilder<T extends Entity, S> {
    // Set once (Signum's `GetState = o => o.State`). graph() stamps it onto every op.
    GetState?: (entity: T) => S;
    // The methods mirror Signum's Graph<T>.Execute / .Delete / .Construct / … class names
    // (PascalCase): each news up the matching Graph.* operation class with T (and S) bound.
    Execute(symbol: ExecuteSymbol<T>, options: ExecuteOptions<T, S>): Graph.Execute<T, S>;
    Delete(symbol: DeleteSymbol<T>, options: DeleteOptions<T, S>): Graph.Delete<T, S>;
    Construct<R extends Entity>(symbol: ConstructSymbol<R>, options: ConstructOptions<R, S>): Graph.Construct<R, S>;
    ConstructFrom<R extends Entity, F extends Entity>(symbol: ConstructSymbol<R, From<F>>, options: ConstructFromOptions<R, F, S>): Graph.ConstructFrom<R, F, S>;
    ConstructFromMany<R extends Entity, F extends Entity>(symbol: ConstructSymbol<R, FromMany<F>>, options: ConstructFromManyOptions<R, F, S>): Graph.ConstructFromMany<R, F, S>;
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
    _type: Type<T>,
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
        Execute: (symbol, options) => collect(new Graph.Execute<T, any>(symbol, options)),
        Delete: (symbol, options) => collect(new Graph.Delete<T, any>(symbol, options)),
        Construct: (symbol, options) => collect(new Graph.Construct(symbol, options)),
        ConstructFrom: (symbol, options) => collect(new Graph.ConstructFrom(symbol, options)),
        ConstructFromMany: (symbol, options) => collect(new Graph.ConstructFromMany(symbol, options)),
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
