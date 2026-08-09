import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import type { Type, Entity, BaseEntity } from "@altea/altea/data/entity";
import type { Quoted } from "quote-transformer/quoted";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeConditionSymbol } from "./Rules.data";

// Port of Signum's TypeConditionLogic (Rules/TypeConditionLogic.cs). The registry mapping each entity
// type + TypeConditionSymbol to the predicate that decides whether a row satisfies that condition. A
// registered condition is used two ways: compiled to a SQL WHERE for row-level query filtering (the
// `@quoted` lambda's `__quoted` expression, lowered by the LINQ binder — Phase D) and evaluated in-memory
// per instance (the same lambda, called directly). In altea a `@quoted` lambda is BOTH a real callable
// (in-memory) AND carries its captured AST (`__quoted`, for SQL), so one lambda serves both — like
// Signum's RegisterCompile, which .Compile()s the expression for the in-memory delegate.
//
// altea divergences from Signum:
//  - `Register<T>` infers T from the C# `Expression<Func<T,bool>>`; altea has no such inference, so the
//    entity ctor is passed explicitly (the registry key).
//  - Signum's QueryAuditor conditions (RegisterWhenAlreadyFiltering*) and thread-local ReplaceTemporally
//    are DEFERRED — they need the query-audit visitor / a testing seam not ported yet.
//  - `_TypeConditions` precompute-on-retrieve (the in-memory fallback when no compiled predicate exists)
//    lands with the enforcement phase; until then inTypeCondition REQUIRES an in-memory condition.

class TypeConditionInfo {
    constructor(
        readonly condition: Quoted<(e: BaseEntity) => boolean>,
        readonly inMemoryCondition: ((e: BaseEntity) => boolean) | undefined,
    ) { }
}

const infos = new Map<Function, Map<TypeConditionSymbol, TypeConditionInfo>>();

export namespace TypeConditionLogic {
    // Signum's TypeConditionLogic.Types — the entity types that have at least one registered condition
    // (the set the enforcement phase installs a FilterQuery on).
    export function types(): Function[] {
        return [...infos.keys()];
    }

    // Signum's TypeConditionLogic.Start seeds the symbol table from the REGISTERED set
    // (`infos.SelectMany(a => a.Value.Keys)`), evaluated lazily at Schema.Initialize (after all Register
    // calls). altea's SymbolLogic assigns ids EAGERLY inside start(), before any Register runs, so a
    // "registered set" thunk would be empty here. Use the default instead — all DECLARED TypeConditionSymbols
    // (every `init()`ed symbol) — which is order-independent and a superset (a declared condition symbol is
    // meant to be registered), so the table is seeded correctly regardless of registration timing.
    export function start(sb: SchemaBuilder): void {
        SymbolLogic.start(sb, TypeConditionSymbol);
    }

    export function register<T extends Entity>(
        ctor: Type<T>,
        typeCondition: TypeConditionSymbol,
        condition: Quoted<(e: T) => boolean>,
        inMemoryCondition?: (e: T) => boolean,
        replace = false,
    ): void {
        if (typeCondition == null)
            throw new Error("typeCondition is required (did the symbol init()?)");
        if (condition == null)
            throw new Error("condition is required");

        let dic = infos.get(ctor);
        if (dic == null)
            infos.set(ctor, dic = new Map());

        const info = new TypeConditionInfo(
            condition as Quoted<(e: BaseEntity) => boolean>,
            inMemoryCondition as ((e: BaseEntity) => boolean) | undefined,
        );
        if (!replace && dic.has(typeCondition))
            throw new Error(`TypeCondition ${typeCondition.key} already registered for ${ctor.name}`);
        dic.set(typeCondition, info);
    }

    // Signum's RegisterCompile — the common form: the same lambda is both the SQL expression and the
    // in-memory evaluator (in altea, a @quoted lambda is already callable, so no separate .Compile()).
    export function registerCompile<T extends Entity>(
        ctor: Type<T>,
        typeCondition: TypeConditionSymbol,
        condition: Quoted<(e: T) => boolean>,
        replace = false,
    ): void {
        register(ctor, typeCondition, condition, condition as (e: T) => boolean, replace);
    }

    export function conditionsFor(ctor: Function): TypeConditionSymbol[] {
        const dic = infos.get(ctor);
        return dic == null ? [] : [...dic.keys()];
    }

    export function isDefined(ctor: Function, typeCondition: TypeConditionSymbol): boolean {
        return infos.get(ctor)?.has(typeCondition) === true;
    }

    // The SQL/expression predicate (Signum's GetCondition) — the @quoted lambda the LINQ binder lowers.
    export function getCondition(ctor: Function, typeCondition: TypeConditionSymbol): Quoted<(e: BaseEntity) => boolean> {
        return infoOrThrow(ctor, typeCondition).condition;
    }

    export function hasInMemoryCondition(ctor: Function, typeCondition: TypeConditionSymbol): boolean {
        return infoOrThrow(ctor, typeCondition).inMemoryCondition != null;
    }

    export function getInMemoryCondition<T extends Entity>(ctor: Type<T>, typeCondition: TypeConditionSymbol): ((e: T) => boolean) | undefined {
        return infoOrThrow(ctor, typeCondition).inMemoryCondition as ((e: T) => boolean) | undefined;
    }

    // Signum's `entity.InTypeCondition(symbol)` — evaluate ONE symbol against ONE instance in-memory.
    // Until _TypeConditions precompute lands (enforcement phase), this requires an in-memory condition.
    export function inTypeCondition<T extends Entity>(entity: T, typeCondition: TypeConditionSymbol): boolean {
        const func = getInMemoryCondition(entity.constructor as Type<T>, typeCondition);
        if (func != null)
            return func(entity);
        throw new Error(
            `TypeCondition ${typeCondition.key} can not be evaluated in-memory for ${entity.constructor.name} ` +
            `and _TypeConditions precompute is not available yet.`);
    }
}

function infoOrThrow(ctor: Function, typeCondition: TypeConditionSymbol): TypeConditionInfo {
    const dic = infos.get(ctor);
    if (dic == null)
        throw new Error(`There's no TypeCondition registered for type ${ctor.name}`);
    const info = dic.get(typeCondition);
    if (info == null)
        throw new Error(`TypeCondition ${typeCondition.key} is not registered for ${ctor.name}`);
    return info;
}
