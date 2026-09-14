import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import type { Type, Entity, BaseEntity, PrimaryKey } from "@altea/altea/data/entity";
import type { Quoted } from "quote-transformer/quoted";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { TypeConditionSymbol } from "../data/Rules";
import { Entity as EntityClass } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    Expression, LambdaExpression, ParameterExpression, PropertyExpression, ConstantExpression,
} from "@altea/altea/server/linq/expressions";
import { replaceParameter } from "@altea/altea/server/linq/expressionReplacer";
import { LiteralType, ClassType, type RuntimeType } from "@altea/altea/server/runtimeTypes";
import type { FilterQueryArgs } from "@altea/altea/server/schema/filterQueryArgs";
import { filterAuditor, isEqualsConstant } from "./QueryAuditorVisitor";
import { quotedReadsPromiseMarker } from "@altea/altea/server/stablePromise";

// Port of Signum.Authorization's Rules/TypeConditionLogic.cs — see port/Auth.md.
//
// The registry mapping each entity type + TypeConditionSymbol to the predicate that decides whether a row
// satisfies that condition. ONE registration serves both uses, because a `@quoted` lambda is BOTH a real
// callable and a carrier of its captured AST: the AST is compiled to a SQL WHERE for row-level filtering,
// and the function itself is called per instance in memory.
//
// `register` takes the entity CTOR explicitly — it is the registry key, and there is no C# expression
// type to infer it from.
//
// A QUERY-AUDITOR condition (`registerWhenAlreadyFilteringBy`) is ASYNC and runs one phase earlier than
// Signum's, in the row-security PROVIDER phase — the one place that has both the query and the ability to
// await. Registration and semantics are unchanged; see QueryAuditorVisitor.ts.
//
// Signum's thread-local `ReplaceTemporally` (a testing seam) is deferred.

/**
 * One registered condition. Exactly ONE of `condition` / `queryAuditor` is set:
 *  • `condition`   — a `@quoted` predicate over the entity: lowered to SQL for the row filter, and
 *                     callable in memory when `inMemoryCondition` is the same lambda.
 *  • `queryAuditor` — a predicate that depends on the CALLER'S QUERY, not on the row: it is handed the
 *                     FilterQueryArgs and answers with `e => true` / `e => false` for that whole query
 *                     (see registerWhenAlreadyFilteringBy). Async, per the header.
 *
 * `inMemoryCondition` is the per-instance predicate and MAY be async — which is what a condition whose SQL
 * half reads a cache through `.$v` needs, since `.$v` only ever means something to the translator and always
 * throws in memory; the twin awaits the same cache instead. `asyncInMemoryCondition` is the equivalent for
 * an auditor condition. An async predicate of either kind is pre-computed by `fillTypeConditions` and
 * cached, which is what keeps `inTypeCondition` SYNCHRONOUS for its callers (a property serializer among
 * them) — the split below is about that one API, not a preference for synchronous predicates.
 */
class TypeConditionInfo {
    // Whether `inMemoryCondition` answers with a promise, declared by being an `async` function. Such a
    // condition cannot answer the synchronous `inTypeCondition` directly, so it is filled and cached
    // exactly like a DB-only one.
    readonly inMemoryIsAsync: boolean;

    constructor(
        readonly condition: Quoted<(e: BaseEntity) => boolean> | undefined,
        readonly inMemoryCondition: ((e: BaseEntity) => boolean | Promise<boolean>) | undefined,
        readonly queryAuditor?: (args: FilterQueryArgs) => Promise<LambdaExpression>,
        readonly asyncInMemoryCondition?: (e: BaseEntity) => Promise<boolean>,
    ) {
        this.inMemoryIsAsync = inMemoryCondition?.constructor?.name === "AsyncFunction";
    }
}

// The per-INSTANCE predicate that cannot answer synchronously — an async in-memory twin, or the auditor's
// async predicate. Both are pre-computed and cached by `fillTypeConditions`.
function asyncPerInstance(info: TypeConditionInfo): ((e: BaseEntity) => Promise<boolean>) | undefined {
    if (info.inMemoryIsAsync)
        return info.inMemoryCondition as (e: BaseEntity) => Promise<boolean>;
    return info.asyncInMemoryCondition;
}

const infos = new Map<Function, Map<TypeConditionSymbol, TypeConditionInfo>>();

export namespace TypeConditionLogic {
    // The entity types that have at least one registered condition
    // (the set the enforcement phase installs a FilterQuery on).
    export function types(): Function[] {
        return [...infos.keys()];
    }

    // Seeded from the REGISTERED conditions, not from every declared one. A declared-but-unregistered
    // symbol has no
    // predicate, so a role rule pointing at it could never be evaluated; the table holding only the
    // registered ones is what makes a rule screen offer exactly the conditions that mean something.
    //
    // The thunk is stored and called at generation / synchronization time, so every `register` below has
    // run by then regardless of module order (the same lazy contract FileTypeLogic and ChartScriptLogic
    // rely on).
    export function start(sb: SchemaBuilder): void {
        // DEDUPED: the same symbol is registered on EVERY type it conditions —
        // `SouthwindTypeCondition.UserEntities` covers UserQuery, UserChart and Dashboard alike — so the
        // flattened registry names it once per type and the symbol table wants it once.
        SymbolLogic.start(sb, TypeConditionSymbol,
            () => [...new Set([...infos.values()].flatMap(dic => [...dic.keys()]))]);
    }

    export function register<T extends Entity>(
        ctor: Type<T>,
        typeCondition: TypeConditionSymbol,
        condition: Quoted<(e: T) => boolean>,
        inMemoryCondition?: (e: T) => boolean | Promise<boolean>,
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
            inMemoryCondition as ((e: BaseEntity) => boolean | Promise<boolean>) | undefined,
        );
        if (!replace && dic.has(typeCondition))
            throw new Error(`TypeCondition ${typeCondition.key} already registered for ${ctor.name}`);
        dic.set(typeCondition, info);
    }

    // The common form: the same lambda is both the SQL expression and the
    // in-memory evaluator (in altea, a @quoted lambda is already callable, so no separate .Compile()).
    export function registerCompile<T extends Entity>(
        ctor: Type<T>,
        typeCondition: TypeConditionSymbol,
        condition: Quoted<(e: T) => boolean>,
        replace = false,
    ): void {
        // `.$v` only means something to the query translator — evaluated in memory it always throws — so a
        // lambda using it cannot BE the in-memory evaluator, which is exactly what this overload makes it.
        // Rejected at registration (start-up, with the symbol named) instead of at whichever per-entity path
        // happens to evaluate it first: the save gate and the property serializer are both far from here.
        if (quotedReadsPromiseMarker(condition))
            throw new Error(
                `TypeCondition ${typeCondition.key} on ${ctor.name} reads \`.$v\`, so it cannot be registered ` +
                `with registerCompile: that form runs the SAME lambda in memory, where \`.$v\` always throws. ` +
                `Use register(...) and give it an in-memory twin that awaits the cache instead.`);
        register(ctor, typeCondition, condition, condition as (e: T) => boolean, replace);
    }

    /**
     * The low-level
     * form: the condition's answer comes from AUDITING THE CALLER'S QUERY rather than from the row.
     *
     * The auditor is handed the {@link FilterQueryArgs} and returns a predicate for that whole query — in
     * practice `e => true` or `e => false`, since "the caller already constrained this" is a property of
     * the query, not of the row. Async in altea (see the header).
     *
     * `asyncInMemoryCondition` is the per-INSTANCE answer, for the paths that have an entity and no query
     * (the save gate, `inTypeCondition`). Without it those paths cannot answer this condition at all.
     *
     * Always REPLACES a previous registration — it assigns rather than adding.
     */
    export function registerWhenAlreadyFiltering<T extends Entity>(
        ctor: Type<T>,
        typeCondition: TypeConditionSymbol,
        queryAuditor: (args: FilterQueryArgs) => Promise<LambdaExpression>,
        asyncInMemoryCondition?: (e: T) => Promise<boolean>,
    ): void {
        if (typeCondition == null)
            throw new Error("typeCondition is required (did the symbol init()?)");
        if (queryAuditor == null)
            throw new Error("queryAuditor is required");

        let dic = infos.get(ctor);
        if (dic == null)
            infos.set(ctor, dic = new Map());
        dic.set(typeCondition, new TypeConditionInfo(undefined, undefined,
            queryAuditor,
            asyncInMemoryCondition as ((e: BaseEntity) => Promise<boolean>) | undefined));
    }

    /**
     * The form every real caller uses: "this row is visible BECAUSE the caller pinned `property` to a
     * value they are allowed to see".
     *
     * The audit looks through the caller's conjuncts for one that pins any of THREE things, in this
     * order, and takes the first that is authorized:
     *   1. `property` itself — `filter(ol => ol.target.is(someInvoice))`. The constant IS the value.
     *   2. the row's `id` — `filter(ol => ol.id == 42)`. The value is read from the database for that id.
     *   3. the ROW — `filter(ol => ol.is(someLog))`. The value comes from that lite / entity.
     * Nothing pinned (or nothing authorized) means the condition does not hold, and the row filter says so.
     *
     * `useInDBForInMemoryCondition` decides how the per-INSTANCE path reads the property: from the
     * database (for a property the in-memory graph may not carry) or by calling the lambda.
     */
    export function registerWhenAlreadyFilteringBy<T extends Entity, P>(
        ctor: Type<T>,
        typeCondition: TypeConditionSymbol,
        options: {
            property: Quoted<(e: T) => P>;
            isConstantAuthorized: (value: P | null) => boolean | Promise<boolean>;
            useInDBForInMemoryCondition: boolean;
        },
    ): void {
        const { property, isConstantAuthorized, useInDBForInMemoryCondition } = options;
        const elementType = new ClassType(ctor);
        const readProperty = property;

        registerWhenAlreadyFiltering<T>(ctor, typeCondition, async args => {
            const audited = filterAuditor(args);
            if (audited.param == null || audited.filters.length === 0)
                return constantLambda(elementType, false);

            // `property` re-based onto the audited row parameter, and the same for the row's id — the two
            // shapes a caller's own filter may name.
            const propertyLambda = Expression.fromQuotedLambda(property, [elementType]);
            const replaced = replaceParameter(propertyLambda.body, propertyLambda.parameters[0], audited.param);
            const replacedId = new PropertyExpression(audited.param, "id");

            for (const filter of audited.filters) {
                // 1. the property pinned to a constant.
                const byProperty = isEqualsConstant(replaced, filter);
                if (byProperty != null && await isConstantAuthorized(convertValue<P>(byProperty.value)))
                    return constantLambda(elementType, true);

                // 2. the row's id pinned: read the property of THAT row, UNGATED —
                //    `ExecutionMode.global` is what stops the read from recursing into the very filter
                //    being built.
                const byId = isEqualsConstant(replacedId, filter);
                if (byId != null && byId.value != null) {
                    const id = byId.value as PrimaryKey;
                    const value = await ExecutionMode.global(() =>
                        table(ctor).filter(e => e.id == id).map(readProperty).singleOrNull());
                    if (await isConstantAuthorized(convertValue<P>(value)))
                        return constantLambda(elementType, true);
                }

                // 3. the ROW itself pinned to a lite or an entity.
                const byRow = isEqualsConstant(audited.param, filter);
                if (byRow != null) {
                    const liteOrEntity = byRow.value;
                    if (liteOrEntity == null)
                        continue;
                    const value = await ExecutionMode.global(async () => {
                        if (liteOrEntity instanceof Lite)
                            return await liteOrEntity.inDB(readProperty);
                        if (liteOrEntity instanceof EntityClass && liteOrEntity.constructor === ctor)
                            return useInDBForInMemoryCondition
                                ? await inDB(ctor, liteOrEntity as T, readProperty)
                                : property(liteOrEntity as T);
                        return MISSING;
                    });
                    if (value === MISSING)
                        continue;
                    // RETURN rather than fall through: a pinned row that is not authorized settles the
                    // question.
                    return constantLambda(elementType, await isConstantAuthorized(convertValue<P>(value)));
                }
            }

            return constantLambda(elementType, false);
        }, async (entity: T) => {
            const value = useInDBForInMemoryCondition
                ? await ExecutionMode.global(() => inDB(ctor, entity, readProperty))
                : property(entity);
            return await isConstantAuthorized(convertValue<P>(value));
        });
    }

    /** True when this condition is a QUERY AUDITOR: it has no SQL predicate of
     *  its own, so the row filter takes its lambda from the audit and the retrieve-time binding skips it. */
    export function isQueryAuditor(ctor: Function, typeCondition: TypeConditionSymbol): boolean {
        return infos.get(ctor)?.get(typeCondition)?.queryAuditor != null;
    }

    /** True if `ctor` has at least one query-auditor condition — lets the row-security provider skip the
     *  audit for the (overwhelmingly common) types that have none. */
    export function hasQueryAuditorConditions(ctor: Function): boolean {
        const dic = infos.get(ctor);
        return dic != null && [...dic.values()].some(i => i.queryAuditor != null);
    }

    /** Run every query-auditor condition of `ctor` against `args` (the provider phase — see the header),
     *  yielding the per-symbol lambda the row filter then splices in. */
    export async function auditQueryConditions(
        ctor: Function,
        args: FilterQueryArgs,
    ): Promise<Map<TypeConditionSymbol, LambdaExpression>> {
        const result = new Map<TypeConditionSymbol, LambdaExpression>();
        const dic = infos.get(ctor);
        if (dic == null)
            return result;
        for (const [symbol, info] of dic)
            if (info.queryAuditor != null)
                result.set(symbol, await info.queryAuditor(args));
        return result;
    }

    export function conditionsFor(ctor: Function): TypeConditionSymbol[] {
        const dic = infos.get(ctor);
        return dic == null ? [] : [...dic.keys()];
    }

    export function isDefined(ctor: Function, typeCondition: TypeConditionSymbol): boolean {
        return infos.get(ctor)?.has(typeCondition) === true;
    }

    // The SQL / expression predicate — the @quoted lambda the LINQ binder lowers.
    // A QUERY-AUDITOR condition has none: its predicate is whatever the audit of the caller's query said,
    // which only the row-security provider can produce (see auditQueryConditions).
    export function getCondition(ctor: Function, typeCondition: TypeConditionSymbol): Quoted<(e: BaseEntity) => boolean> {
        const info = infoOrThrow(ctor, typeCondition);
        if (info.condition == null)
            throw new Error(
                `TypeCondition ${typeCondition.key} on ${ctor.name} is implemented as a query auditor and ` +
                `has no predicate of its own — it can only be used where the caller's query is known ` +
                `— see port/Auth.md.`);
        return info.condition;
    }

    /**
     * Whether the condition can answer the SYNCHRONOUS `inTypeCondition` from the instance alone. False for
     * a DB-only condition and for one whose in-memory twin is async — both are pre-computed and cached
     * instead (the retrieve-time additional binding, or `fillTypeConditions`).
     */
    export function hasSyncInMemoryCondition(ctor: Function, typeCondition: TypeConditionSymbol): boolean {
        const info = infoOrThrow(ctor, typeCondition);
        return info.inMemoryCondition != null && !info.inMemoryIsAsync;
    }

    export function getInMemoryCondition<T extends Entity>(ctor: Type<T>, typeCondition: TypeConditionSymbol): ((e: T) => boolean) | undefined {
        const info = infoOrThrow(ctor, typeCondition);
        return info.inMemoryIsAsync ? undefined : info.inMemoryCondition as ((e: T) => boolean) | undefined;
    }

    // Evaluate ONE symbol against ONE instance. A condition
    // registered with `registerCompile` runs its compiled predicate live; a DB-ONLY condition (plain
    // `register`) can't run in memory, so its boolean must have been pre-computed and cached on the entity
    // on the entity. An entity read through the ORM is filled automatically by the retrieve-time
    // additional binding — TypeAuthLogic registers one per DB-only condition, and the value is folded into
    // the retrieval SELECT, so 0 extra queries. For an entity NOT read via
    // a query (e.g. a fresh instance on the save path), `fillTypeConditions` fills on demand. If neither ran,
    // we throw rather than silently returning a wrong (unfilled) answer.
    export function inTypeCondition<T extends Entity>(entity: T, typeCondition: TypeConditionSymbol): boolean {
        const func = getInMemoryCondition(entity.constructor as Type<T>, typeCondition);
        if (func != null) {
            const answer = func(entity) as boolean | Promise<boolean>;
            // A predicate that hands back a promise without being declared `async` would otherwise be TRUTHY
            // here — every row silently satisfying the condition. Name it instead: a promise-returning twin
            // must be `async`, which is what routes it through the fill + cache below.
            if (answer instanceof Promise)
                throw new Error(
                    `The in-memory predicate of TypeCondition ${typeCondition.key} on ${entity.constructor.name} ` +
                    `returned a promise but is not declared \`async\`, so it cannot be pre-computed. Declare it ` +
                    `\`async\` — then it is filled and cached like a DB-only condition.`);
            return answer;
        }
        const cached = conditionCache.get(entity);
        if (cached == null || !cached.has(typeCondition))
            throw new Error(
                `TypeCondition ${typeCondition.key} has no synchronous in-memory predicate for ${entity.constructor.name} ` +
                `and its value isn't cached — call TypeConditionLogic.fillTypeConditions([...]) on the batch first.`);
        return cached.get(typeCondition)!;
    }

    // DB-eval results per entity, kept in a WeakMap so it doesn't
    // pollute the reflected entity shape. Undefined until `fillTypeConditions` runs.
    const conditionCache = new WeakMap<Entity, Map<TypeConditionSymbol, boolean>>();

    /** The cached DB-eval results for an entity, or undefined. */
    export function typeConditionsOf(entity: Entity): ReadonlyMap<TypeConditionSymbol, boolean> | undefined {
        return conditionCache.get(entity);
    }

    /** Cache one DB-eval boolean for an entity. The
     *  primary writer is the retrieve-time additional binding (QueryBinder folds each DB-only condition into
     *  the SELECT and the projector calls this per row); `fillTypeConditions` writes the same cache for the
     *  save path / entities not read through the ORM. Read back synchronously by `inTypeCondition`. */
    export function setCached(entity: Entity, typeCondition: TypeConditionSymbol, value: boolean): void {
        let m = conditionCache.get(entity);
        if (m == null) { m = new Map(); conditionCache.set(entity, m); }
        m.set(typeCondition, value);
    }

    // Evaluate the DB-ONLY conditions (those without an in-memory
    // predicate) of a batch of SAME-TYPE entities in SQL and cache the booleans per entity. One query per
    // DB-only condition — the ids satisfying its `@quoted` predicate (the very predicate the row filter
    // lowers to SQL) — so `inTypeCondition` can then read the result synchronously. In-memory conditions are
    // skipped (evaluated live). No DB-only conditions for the type ⇒ a no-op (no query), so the common
    // all-`registerCompile` case never touches the database.
    export async function fillTypeConditions<T extends Entity>(entities: readonly T[], typeConditions?: readonly TypeConditionSymbol[]): Promise<void> {
        if (entities.length === 0)
            return;
        const ctor = entities[0].constructor as Type<T>;
        // Everything that cannot answer synchronously: DB-only conditions AND those whose in-memory twin is
        // async (the shape a condition takes when its SQL half reads a cache through `.$v`).
        const dbOnly = (typeConditions ?? conditionsFor(ctor)).filter(tc => !hasSyncInMemoryCondition(ctor, tc));
        if (dbOnly.length === 0)
            return;
        // IDEMPOTENT: an entity is filled for ALL its DB-only conditions at once, so a
        // cached entity is skipped — lets the retrieve/save integration fill once and later callers reuse.
        const need = entities.filter(e => conditionCache.get(e) == null);
        if (need.length === 0)
            return;
        const ids = need.map(e => e.id!);
        // Evaluate the raw predicate on these ids in GLOBAL mode: no row-level
        // security on the fill query itself, and — since it runs ungated + projects ids only (no entity
        // materialisation) — the retrieve batch-hook can't recurse into it.
        const setCachedValue = (e: T, tc: TypeConditionSymbol, value: boolean): void => {
            let m = conditionCache.get(e);
            if (m == null) { m = new Map(); conditionCache.set(e, m); }
            m.set(tc, value);
        };

        // A QUERY-AUDITOR condition has no SQL predicate; its per-instance answer is the async in-memory
        // one its registration supplied, evaluated once per entity. That is what keeps the synchronous
        // `inTypeCondition` able to answer for such a condition at all.
        //
        // It is evaluated OUTSIDE the global scope below, and that is not incidental: the predicate is an
        // AUTHORIZATION decision (`isAllowedForLite` for the row's target, in the DiffLog case), and
        // ExecutionMode.global switches authorization OFF — inside it every such question answers "yes".
        // Global mode belongs to the SQL predicate path, where its job is to keep the fill query itself
        // from being row-filtered.
        // An ASYNC in-memory twin is answered here too, and PREFERRED over this condition's own SQL
        // predicate when it has one: the twin is what the registrar supplied precisely for the entities the
        // batch below cannot reach — a fresh instance on the save path has no id to match on.
        for (const tc of dbOnly) {
            const info = infoOrThrow(ctor, tc);
            const perInstance = asyncPerInstance(info);
            if (perInstance == null) {
                // Neither an async predicate nor a SQL one: the condition cannot be evaluated per instance,
                // and "not satisfied" is the safe answer (a type condition can only ever GRANT access).
                if (info.condition == null)
                    for (const e of need)
                        setCachedValue(e, tc, false);
                continue;
            }
            for (const e of need)
                setCachedValue(e, tc, await perInstance(e));
        }

        await ExecutionMode.global(async () => {
            for (const tc of dbOnly) {
                const info = infoOrThrow(ctor, tc);
                if (info.condition == null || asyncPerInstance(info) != null)
                    continue; // handled above
                const predicate = info.condition;
                const yesIds = await table(ctor).filter(predicate).filter(e => ids.includes(e.id)).map(e => e.id).toArray() as PrimaryKey[];
                const yes = new Set(yesIds.map(String));
                for (const e of need)
                    setCachedValue(e, tc, yes.has(String(e.id)));
            }
        });
    }

    /** True if `ctor` has at least one DB-only condition (needs SQL fill) — lets the retrieve/save
     *  integration skip types whose conditions are all in-memory. */
    export function hasDbOnlyConditions(ctor: Function): boolean {
        return conditionsFor(ctor).some(tc => !hasSyncInMemoryCondition(ctor, tc));
    }
}

// A constant predicate as a LambdaExpression — what an audit answers with. It is a whole-QUERY verdict,
// so it is constant per row by construction.
function constantLambda(elementType: RuntimeType, value: boolean): LambdaExpression {
    return new LambdaExpression(
        [new ParameterExpression("e", elementType)],
        new ConstantExpression(value, LiteralType.boolean));
}

// A sentinel for "this branch produced no value", distinct from a real `null` / `undefined` property.
const MISSING = Symbol("missing");

// Read one property of one entity from the DATABASE — for a property whose in-memory value may be stale
// or absent.
async function inDB<T extends Entity>(ctor: Type<T>, entity: T, property: Quoted<(e: T) => unknown>): Promise<unknown> {
    const id = entity.id;
    if (id == null)
        return undefined; // a new row has nothing stored yet
    return await table(ctor).filter(e => e.id == id).map(property).singleOrNull();
}

// Line up what the audit found with what the caller's
// `isConstantAuthorized` expects. The one coercion that matters in practice is entity to lite — a caller
// may pin a Lite-typed property with a full entity (`filter(ol => ol.target.is(theInvoice))`) — and its
// mirror. A value that is NEITHER is handed over as it is, for the caller to interpret: TypeScript does
// not know P at runtime, so there is nothing to coerce it to.
function convertValue<P>(value: unknown): P | null {
    if (value == null)
        return null;
    if (value instanceof EntityClass)
        return value.toLite() as P;
    return value as P;
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
