import type { Entity } from './entity';
import { OperationSymbol } from './operationSymbol';

// The typed symbol containers — the CLIENT-SAFE declaration side used to write
// `export namespace XOperation { export const … = init() }` (mirroring `OrderEntity.cs`'s
// `[AutoInit] static class OrderOperation`). The concrete entity lives in ./operationSymbol;
// it is re-exported here so `@altea/altea/entities/operations` stays the single import for
// the whole operation-declaration surface (and so the transformer's injected
// `import { OperationSymbol }` — which targets this module — resolves). The operation
// implementations (the Graph) live server-side in the logic layer.
export { OperationSymbol };

// Typed containers — compile-time-only refinements of OperationSymbol. The phantom
// `_execute_` / `_delete_` / `_construct_` / `_source_` members never exist at runtime
// (`init()` returns a plain OperationSymbol); they exist purely so the graph builder and
// the OperationLogic service entrypoints can (a) tell an Execute symbol from a
// Delete/Construct one and (b) thread the entity type `T` — and, for the constructors, the
// source `F`. Port of Signum's ExecuteSymbol<in T>, ConstructSymbol<T>.Simple/.From<F>/
// .FromMany<F>, DeleteSymbol<in T> (TS cannot express `ConstructSymbol<T>.From<F>` as a
// nested generic, so the source is the second type arg via the markers below).
export interface ExecuteSymbol<T extends Entity> extends OperationSymbol { _execute_: T /*TRICK*/ }
export interface DeleteSymbol<T extends Entity> extends OperationSymbol { _delete_: T /*TRICK*/ }

// Source descriptors for ConstructSymbol's second type argument. They make a constructor
// declaration read like a sentence — "construct <T>", "construct <T> From <F>", "construct
// <T> FromMany <F>" — so it's unambiguous which type is the RESULT (always the first arg,
// T) and which is the SOURCE (inside From/FromMany). Marker interfaces, compile-time only.
export interface Simple { readonly _constructKind_: "Simple" /*TRICK*/ }
export interface From<F extends Entity> { readonly _constructKind_: "From"; readonly _source_: F /*TRICK*/ }
export interface FromMany<F extends Entity> { readonly _constructKind_: "FromMany"; readonly _source_: F /*TRICK*/ }

// A constructor operation producing T. The second arg selects the kind + source:
//   ConstructSymbol<Order>                     — Simple  (no source)
//   ConstructSymbol<Order, From<Customer>>     — from one Customer
//   ConstructSymbol<Order, FromMany<Product>>  — from many Products
// The distinct `_constructKind_` literals keep the three shapes from being mixed up by the
// graph builder / service entrypoints (a From symbol can't be passed to construct(), etc.),
// and R/F are inferred back out at those call sites.
export interface ConstructSymbol<T extends Entity, Src extends Simple | From<Entity> | FromMany<Entity> = Simple> extends OperationSymbol {
    _construct_: T /*TRICK*/;
    _constructSource_: Src /*TRICK*/;
}
