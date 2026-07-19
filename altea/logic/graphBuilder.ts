import type { Entity } from "../entities/entity";
import type { Lite } from "../entities/lite";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../entities/operations";
import { Graph } from "./graph";

// `graph(Order, OrderState, g => { g.GetState = o => o.state; g.Execute(sym, { … }); … })`
// — sugar over the Graph.* operation classes (./graph): news each up with T (and S) bound
// so they aren't repeated, Object.assigns the options onto it, stamps the graph's GetState
// onto each, and registers them all on register(). The option objects mirror the classes'
// fields (minus getState, which is set once per graph). For full control, skip this and
// use the Graph.* classes directly.

export interface ExecuteOptions<T extends Entity, S> {
    execute: (entity: T, args: unknown[]) => void | Promise<void>;
    canExecute?: (entity: T) => string | null;
    canBeNew?: boolean;
    canBeModified?: boolean;
    avoidImplicitSave?: boolean;
    fromStates?: S[];
    toStates?: S[];
}
export interface DeleteOptions<T extends Entity, S> {
    delete: (entity: T, args: unknown[]) => void | Promise<void>;
    canDelete?: (entity: T) => string | null;
    fromStates?: S[];
}
export interface ConstructOptions<T extends Entity, S> {
    construct: (args: unknown[]) => T | Promise<T>;
    toStates?: S[];
}
export interface ConstructFromOptions<F extends Entity, T extends Entity, S> {
    construct: (from: F, args: unknown[]) => T | Promise<T>;
    canConstruct?: (from: F) => string | null;
    canBeNew?: boolean;
    resultIsSaved?: boolean;
    toStates?: S[];
}
export interface ConstructFromManyOptions<F extends Entity, T extends Entity, S> {
    construct: (lites: Lite<F>[], args: unknown[]) => T | Promise<T>;
    toStates?: S[];
}

export interface GraphBuilder<T extends Entity, S> {
    // Set once (Signum's `GetState = o => o.State`). graph() stamps it onto every op.
    GetState?: (entity: T) => S;
    // The methods mirror Signum's Graph<T>.Execute / .Delete / .Construct / … class names
    // (PascalCase): each news up the matching Graph.* operation class with T (and S) bound.
    Execute(symbol: ExecuteSymbol<T>, options: ExecuteOptions<T, S>): Graph.Execute<T, S>;
    Delete(symbol: DeleteSymbol<T>, options: DeleteOptions<T, S>): Graph.Delete<T, S>;
    Construct<R extends Entity>(symbol: ConstructSymbol<R>, options: ConstructOptions<R, S>): Graph.Construct<R, S>;
    ConstructFrom<R extends Entity, F extends Entity>(symbol: ConstructSymbol<R, From<F>>, options: ConstructFromOptions<F, R, S>): Graph.ConstructFrom<R, F, S>;
    ConstructFromMany<R extends Entity, F extends Entity>(symbol: ConstructSymbol<R, FromMany<F>>, options: ConstructFromManyOptions<F, R, S>): Graph.ConstructFromMany<R, F, S>;
}

export interface GraphRegistration {
    // The operations collected by the callback (for inspection / manual tweaking).
    readonly operations: readonly { register(replace?: boolean): unknown; getState?: unknown }[];
    // Stamps getState onto each op (Signum's shared GetState) and registers them all.
    register(): void;
}

export function graph<T extends Entity>(type: new () => T, define: (g: GraphBuilder<T, never>) => void): GraphRegistration;
export function graph<T extends Entity, E extends object>(type: new () => T, stateEnum: E, define: (g: GraphBuilder<T, E[keyof E]>) => void): GraphRegistration;
export function graph<T extends Entity>(
    _type: new () => T,
    defineOrEnum: unknown,
    maybeDefine?: (g: GraphBuilder<T, any>) => void,
): GraphRegistration {
    const define = (maybeDefine ?? defineOrEnum) as (g: GraphBuilder<T, any>) => void;

    const collected: { register(replace?: boolean): unknown; getState?: unknown }[] = [];
    const push = <O extends { register(replace?: boolean): unknown; getState?: unknown }>(op: O, options: object): O => {
        Object.assign(op, options);
        collected.push(op);
        return op;
    };

    const g: GraphBuilder<T, any> = {
        GetState: undefined,
        Execute: (symbol, options) => push(new Graph.Execute<T, any>(symbol), options),
        Delete: (symbol, options) => push(new Graph.Delete<T, any>(symbol), options),
        Construct: (symbol, options) => push(new Graph.Construct(symbol), options),
        ConstructFrom: (symbol, options) => push(new Graph.ConstructFrom(symbol), options),
        ConstructFromMany: (symbol, options) => push(new Graph.ConstructFromMany(symbol), options),
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
