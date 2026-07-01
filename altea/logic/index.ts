// Server-side extension methods on the entity model. The entity classes
// (entities/) stay server-agnostic; the methods that need the server — persisting
// a graph (`save`) or turning an entity/lite into a query (`inDB`, `retrieve`,
// `retrieveAndRemember`) — are declared and installed here, in one place.
//
// Importing this module installs the prototypes (side effect). The ported test
// suite pulls it in via MusicLoader; the type augmentations are ambient (the file
// is part of the @altea/altea program), so callers see the methods without importing.

import { Entity } from '../entities/entity';
import { Lite } from '../entities/lite';
import type { IQuery } from '../entities/iquery';
import type { Quoted } from 'quote-transformer/quoted';
import { Saver } from './saver';
import { table } from './table';
import { asStaticFunction, Query } from './query';
import { ArrayType, FunctionType, LiteType, LiteralType, Type } from '../entities/types';
import { CallExpression, ConstantExpression, Expression, LambdaExpression, ParameterExpression, PropertyExpression } from './linq/expressions';
import { ExpressionVisitor } from './linq/visitors/ExpressionVisitor';

// Logic-layer barrel: re-exports the common server entry points alongside installing
// the entity/lite extension-method prototypes (below).
export { table, view } from './table';
export { deleteList } from './Database';
// from ./schema/schemaBuilder (not the ./schema barrel) — `./schema` is ambiguous at
// runtime (a schema.ts file and a schema/ directory both exist; ESM resolves to the dir).
export { SchemaBuilder } from './schema/schemaBuilder';

declare module '../entities/entity' {
    interface Entity {
        // Saves this entity and its reachable graph in one transaction, returning the
        // entity so calls chain inline (Signum's `new XEntity { … }.Execute(Save)`).
        save(): Promise<this>;
        // Re-query this single in-memory entity against the database (Signum's InDB).
        // `inDB()` yields a one-row query; `inDB(selector)` projects it to a scalar.
        inDB(): IQuery<this>;
        inDB<V>(selector: Quoted<(entity: this) => V>): V;
        // Delete this single entity from the database (Signum's Entity.Delete): a
        // one-row query (inDB) followed by a set-based delete; exactly one row must be
        // affected, otherwise the entity was already deleted / concurrently modified.
        delete(): Promise<void>;
        // Polymorphic combine hint over an @implementedBy reference (Signum's
        // CombineUnion / CombineCase): picks how the query provider merges the
        // implementations when a member is navigated — combineUnion() a UNION ALL
        // sub-select joined once, combineCase() a CASE over the implementation columns.
        // Query-only markers (identity in memory). The return type is `any` because
        // altea has no interface type to upcast to (unlike Signum's `IFooEntity`); the
        // navigated member (`.name`, `.lastAward`, …) is resolved by the binder against
        // the concrete implementations.
        combineUnion(): this;
        combineCase(): this;
    }
}

declare module '../entities/lite' {
    interface Lite<out T extends Entity> {
        // Re-query the referenced entity (Signum's Lite.InDB).
        inDB(): IQuery<T>;
        inDB<V>(selector: Quoted<(entity: T) => V>): V;
        // Retrieve the referenced entity from the database.
        retrieve(): T;
        // Retrieve the referenced entity and cache it on the lite (Signum's RetrieveAndRemember).
        retrieveAndRemember(): T;
        // Delete the referenced entity (Signum's Lite.Delete) — see Entity.delete.
        delete(): Promise<void>;
    }
}

Entity.prototype.save = async function (this: Entity): Promise<Entity> {
    await Saver.save([this]);
    return this;
};

// Polymorphic combine hints (Signum's CombineUnion/CombineCase). Identity at runtime
// — the combine strategy only matters in a query, where the binder reads it off the
// call and swaps the @implementedBy reference's strategy (see QueryBinder). The
// `__resultType` is the identity resolver so the combined reference keeps the
// receiver's type through the quote transform.
const combineUnion = function (this: Entity): unknown { return this; };
const combineCase = function (this: Entity): unknown { return this; };
asStaticFunction(combineUnion).__resultType = (ot: Type) => ot;
asStaticFunction(combineCase).__resultType = (ot: Type) => ot;
(Entity.prototype as any).combineUnion = combineUnion;
(Entity.prototype as any).combineCase = combineCase;

// Entity → query bridge (Signum's Database.InDB): a one-row query filtered to this
// entity's id. `inDB(selector)` projects and takes the single row. Used at the top
// level (executed) and — via the binder's inDB expander — inside quoted lambdas.
const entityInDB = function (this: Entity, selector?: Quoted<(e: Entity) => unknown>): unknown {
    const self = this;
    const query = table(self.constructor as any).filter(e => e.is(self));
    return selector == null ? query : query.map(selector as any).single();
};
// Quote metadata so `entity.inDB(a => …)` typed inside a quoted lambda resolves the
// selector's parameter (the entity) and result type (the selector's return), the way
// the binder's inDB expander needs.
const entityInDBSf = asStaticFunction(entityInDB);
entityInDBSf.__lambdaType = [(ot: Type) => [ot]];
entityInDBSf.__resultType = (ot: Type, selType?: Type) => selType instanceof FunctionType ? selType.returnType : new ArrayType(ot);
entityInDBSf.__methodExpander = expandInDB;
(Entity.prototype as any).inDB = entityInDB;

const liteInDB = function (this: Lite<Entity>, selector?: Quoted<(e: Entity) => unknown>): unknown {
    const self = this;
    const query = table(self.entityType as any).filter(e => e.is(self));
    return selector == null ? query : query.map(selector as any).single();
};
const entityTypeOf = (ot: Type): Type => ot instanceof LiteType ? ot.entityType : ot;
const liteInDBSf = asStaticFunction(liteInDB);
liteInDBSf.__lambdaType = [(ot: Type) => [entityTypeOf(ot)]];
liteInDBSf.__resultType = (ot: Type, selType?: Type) => selType instanceof FunctionType ? selType.returnType : new ArrayType(entityTypeOf(ot));
liteInDBSf.__methodExpander = expandInDB;
(Lite.prototype as any).inDB = liteInDB;

// Delete a single row (Signum's Entity.Delete / Lite.Delete): re-query it as a one-row
// query (inDB) and run a set-based delete over that query. Exactly one row must be
// affected — anything else means the row was already gone / concurrently changed.
async function deleteOne(query: IQuery<Entity>, target: unknown): Promise<void> {
    const affected = await (query as unknown as Query<Entity>).executeDelete();
    if (affected !== 1)
        throw new Error(`Delete of '${target}' affected ${affected} rows, expected 1.`);
}
Entity.prototype.delete = function (this: Entity): Promise<void> {
    return deleteOne(this.inDB(), this);
};
Lite.prototype.delete = function (this: Lite<Entity>): Promise<void> {
    return deleteOne(this.inDB(), this);
};

// Signum's InDbExpander (run in ExpressionSimplifier, not the binder): rewrites an
// `x.inDB(sel)` call inside a quoted lambda into a source expression, before binding.
//  - A captured constant entity/lite → `x.inDB().map(sel).single()`, where the runtime
//    `x.inDB()` builds `table(<x's concrete type>)…` — so `animal.inDB(a => a.legs)`
//    queries `table(Cat)` or `table(Dog)` per the runtime type of `animal`.
//  - A bound (non-constant) reference is a no-op re-query, so the selector applies in
//    place (`sel(entity)`), by substituting its parameter with the receiver.
function expandInDB(instance: Expression | undefined, args: readonly Expression[]): Expression {
    const selector = args.length > 0 ? args[0] : undefined;

    // Partial-eval the receiver (Signum's ExpressionEvaluator.PartialEval): a captured
    // constant entity — or `entity.toLite()` on one — resolves to a runtime value.
    const value = partialEval(instance);
    if (value instanceof Entity || value instanceof Lite) {
        // `value.inDB()` builds `table(<value's concrete type>)…` at runtime, so the
        // query targets the actual subclass (Cat vs Dog) of a polymorphic reference.
        const query = (value as any).inDB() as { expression: Expression };
        let expr: Expression = query.expression;
        if (selector instanceof LambdaExpression) {
            const bodyType = selector.body.type ?? LiteralType.null;
            expr = new CallExpression(new PropertyExpression(expr, "map", false), [selector], new ArrayType(bodyType));
            expr = new CallExpression(new PropertyExpression(expr, "single", false), [], bodyType);
        }
        return expr;
    }

    // Non-constant receiver: the re-query is a no-op — apply the selector in place.
    if (selector instanceof LambdaExpression && instance != null)
        return new ParamReplacer(selector.parameters[0], instance).visit(selector.body);
    return instance ?? new ConstantExpression(null);
}

// Evaluates an expression to a runtime value if it's a constant, or a zero-arg method
// call chain over constants (`female.toLite()`) — a scoped port of Signum's PartialEval.
function partialEval(e: Expression | undefined): unknown {
    if (e instanceof ConstantExpression)
        return e.value;
    if (e instanceof CallExpression && e.func instanceof PropertyExpression && e.args.length === 0) {
        const receiver = partialEval(e.func.object);
        const fn = receiver == null ? undefined : (receiver as Record<string, unknown>)[e.func.propertyName];
        if (typeof fn === "function")
            return (fn as (...a: unknown[]) => unknown).call(receiver);
    }
    return undefined;
}

// Substitutes a lambda parameter with an expression (beta reduction) — Signum's
// Expression.Invoke(lambda, arg) for the non-constant InDB fallback.
class ParamReplacer extends ExpressionVisitor {
    constructor(private readonly param: ParameterExpression, private readonly replacement: Expression) { super(); }
    override visitParameter(p: ParameterExpression): Expression {
        return p === this.param ? this.replacement : p;
    }
}

Lite.prototype.retrieve = function (this: Lite<Entity>): never {
    throw new Error("retrieve (lite→entity) is not implemented yet");
};

Lite.prototype.retrieveAndRemember = function (this: Lite<Entity>): never {
    throw new Error("retrieveAndRemember is not implemented yet");
};

// Relational joins on a collection — the in-quoted-lambda analogue of Query's
// innerJoin/leftJoin/rightJoin/fullJoin (they borrow Query's lambda/result-type
// metadata by name in the expression layer). They are query-only; calling them on a
// materialised array throws for now (no in-memory implementation yet). `join` stays
// the native string concatenation (Signum's IEnumerable.ToString) on both sides.
declare global {
    interface Array<T> {
        innerJoin<K, O, R>(otherSource: O[], keySelector: (element: T) => K, otherKeySelector: (otherElement: O) => K, resultSelector: (element: T, otherElement: O) => R): R[];
        leftJoin<K, O, R>(otherSource: O[], keySelector: (element: T) => K, otherKeySelector: (otherElement: O) => K, resultSelector: (element: T, otherElement: O | null) => R): R[];
        rightJoin<K, O, R>(otherSource: O[], keySelector: (element: T) => K, otherKeySelector: (otherElement: O) => K, resultSelector: (element: T | null, otherElement: O) => R): R[];
        fullJoin<K, O, R>(otherSource: O[], keySelector: (element: T) => K, otherKeySelector: (otherElement: O) => K, resultSelector: (element: T | null, otherElement: O | null) => R): R[];
    }
}

for (const op of ["innerJoin", "leftJoin", "rightJoin", "fullJoin"] as const) {
    (Array.prototype as any)[op] = function (): never {
        throw new Error(`'${op}' is a query-only relational join (not supported on an in-memory array yet)`);
    };
}
