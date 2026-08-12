import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import type { Type, Entity, BaseEntity, PrimaryKey } from "@altea/altea/data/entity";
import type { Quoted } from "quote-transformer/quoted";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { TypeConditionSymbol } from "../data/Rules";

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

    // Signum's `entity.InTypeCondition(symbol)` — evaluate ONE symbol against ONE instance. A condition
    // registered with `registerCompile` runs its compiled predicate live; a DB-ONLY condition (plain
    // `register`) can't run in memory, so its boolean must have been pre-computed and cached on the entity
    // (Signum reads `entity._TypeConditions`). An entity read through the ORM is filled automatically by the
    // retrieve-time additional binding (Signum's RegisterBinding — TypeAuthLogic registers one per DB-only
    // condition; the value is folded into the retrieval SELECT, 0 extra queries). For an entity NOT read via
    // a query (e.g. a fresh instance on the save path), `fillTypeConditions` fills on demand. If neither ran,
    // we throw rather than silently returning a wrong (unfilled) answer.
    export function inTypeCondition<T extends Entity>(entity: T, typeCondition: TypeConditionSymbol): boolean {
        const func = getInMemoryCondition(entity.constructor as Type<T>, typeCondition);
        if (func != null)
            return func(entity);
        const cached = conditionCache.get(entity);
        if (cached == null || !cached.has(typeCondition))
            throw new Error(
                `TypeCondition ${typeCondition.key} has no in-memory predicate for ${entity.constructor.name} and its DB ` +
                `value isn't cached — call TypeConditionLogic.fillTypeConditions([...]) on the batch first.`);
        return cached.get(typeCondition)!;
    }

    // Signum's Entity._typeConditions cache — DB-eval results per entity, kept in a WeakMap so it doesn't
    // pollute the reflected entity shape. Undefined until `fillTypeConditions` runs.
    const conditionCache = new WeakMap<Entity, Map<TypeConditionSymbol, boolean>>();

    /** The cached DB-eval results for an entity (Signum's `entity._TypeConditions` getter), or undefined. */
    export function typeConditionsOf(entity: Entity): ReadonlyMap<TypeConditionSymbol, boolean> | undefined {
        return conditionCache.get(entity);
    }

    /** Cache one DB-eval boolean for an entity (Signum's `entity._TypeConditions[symbol] = value`). The
     *  primary writer is the retrieve-time additional binding (QueryBinder folds each DB-only condition into
     *  the SELECT and the projector calls this per row); `fillTypeConditions` writes the same cache for the
     *  save path / entities not read through the ORM. Read back synchronously by `inTypeCondition`. */
    export function setCached(entity: Entity, typeCondition: TypeConditionSymbol, value: boolean): void {
        let m = conditionCache.get(entity);
        if (m == null) { m = new Map(); conditionCache.set(entity, m); }
        m.set(typeCondition, value);
    }

    // Signum's TypeAuthLogic.FillTypeConditions: evaluate the DB-ONLY conditions (those without an in-memory
    // predicate) of a batch of SAME-TYPE entities in SQL and cache the booleans per entity. One query per
    // DB-only condition — the ids satisfying its `@quoted` predicate (the very predicate the row filter
    // lowers to SQL) — so `inTypeCondition` can then read the result synchronously. In-memory conditions are
    // skipped (evaluated live). No DB-only conditions for the type ⇒ a no-op (no query), so the common
    // all-`registerCompile` case never touches the database.
    export async function fillTypeConditions<T extends Entity>(entities: readonly T[], typeConditions?: readonly TypeConditionSymbol[]): Promise<void> {
        if (entities.length === 0)
            return;
        const ctor = entities[0].constructor as Type<T>;
        const dbOnly = (typeConditions ?? conditionsFor(ctor)).filter(tc => !hasInMemoryCondition(ctor, tc));
        if (dbOnly.length === 0)
            return;
        // Idempotent (Signum's `!force`): an entity is filled for ALL its DB-only conditions at once, so a
        // cached entity is skipped — lets the retrieve/save integration fill once and later callers reuse.
        const need = entities.filter(e => conditionCache.get(e) == null);
        if (need.length === 0)
            return;
        const ids = need.map(e => e.id!);
        // Evaluate the raw predicate on these ids in GLOBAL mode (Signum's DisableQueryFilter): no row-level
        // security on the fill query itself, and — since it runs ungated + projects ids only (no entity
        // materialisation) — the retrieve batch-hook can't recurse into it.
        await ExecutionMode.global(async () => {
            for (const tc of dbOnly) {
                const predicate = getCondition(ctor, tc) as Quoted<(e: T) => boolean>;
                const yesIds = await table(ctor).filter(predicate).filter(e => ids.includes(e.id)).map(e => e.id).toArray() as PrimaryKey[];
                const yes = new Set(yesIds.map(String));
                for (const e of need) {
                    let m = conditionCache.get(e);
                    if (m == null) { m = new Map(); conditionCache.set(e, m); }
                    m.set(tc, yes.has(String(e.id)));
                }
            }
        });
    }

    /** True if `ctor` has at least one DB-only condition (needs SQL fill) — lets the retrieve/save
     *  integration skip types whose conditions are all in-memory. */
    export function hasDbOnlyConditions(ctor: Function): boolean {
        return conditionsFor(ctor).some(tc => !hasInMemoryCondition(ctor, tc));
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
