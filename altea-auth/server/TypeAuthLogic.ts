import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/server/resetLazy";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { CallExpression, type Expression, LambdaExpression, PropertyExpression, UnaryExpression } from "@altea/altea/server/linq/expressions";
import { ClassType, LiteralType, type RuntimeType } from "@altea/altea/server/runtimeTypes";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeLogic, type TypeCaches } from "@altea/altea/server/typeLogic";
import { markStable, stableValue } from "@altea/altea/server/stablePromise";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { preSaveGates } from "@altea/altea/server/saver";
import { postRetrieveGates } from "@altea/altea/server/linq/Retriever";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { cleanTypeName, getLocation } from "@altea/altea/data/registration";
import type { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import type { PrimaryKey, Type } from "@altea/altea/data/entity";
import { toInt } from "@altea/altea/data/basics";
import { AuthLogic, RoleGraph } from "./AuthLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import {
    RuleTypeEntity, RuleTypeConditionEntity, RuleTypeConditionEntity_Condition,
    TypeAllowed, TypeAllowedBasic, typeAllowedGet, typeAllowedCreate,
    TypeRulePack, TypeAllowedRule, TypeConditionSymbol, DimensionSummaryModel,
    WithConditionsModel, ConditionRuleModel,
} from "../data/Rules";
import { isEnumEntityType } from "@altea/altea/data/enumEntity";
import { computePartRoots, partParentChains } from "./PartOwnership";
import { UserEntity, UserState, UserTypeCondition } from "../data/User";
import { TypeConditionLogic } from "./TypeConditionLogic";
import { WithConditions, ConditionRule, maxBound, minBound, maxDB, maxUI } from "./WithConditions";
import { mergeTypeConditions } from "./TypeConditionMerger";
import { buildAuthFilter, authFilterLambda, rebasePartFilter, conditionValueLambda } from "./TypeConditionAlgebra";
import { FilterQueryArgs, findQuerySources, querySourceCtor } from "@altea/altea/server/schema/filterQueryArgs";
import { computeAllowed, type ComputedCache } from "./AuthCache";
import { section, groupByRole, attrs, conditionsXml, condLites, parseEnum, type AuthImportCtx, type XmlRoleBlock } from "./AuthRulesXml";
import type { AuthExportCtx } from "./AuthLogic";

// Port of Signum.Authorization's Rules/TypeAuthLogic.cs + .Conditions.cs — see port/Auth.md.
//
// A role's access to an entity TYPE, with ROW-LEVEL type conditions: a `WithConditions<TypeAllowed>` — a
// fallback plus ordered condition rules — merged across the role graph by the 2^n TypeConditionMerger,
// and evaluated against a concrete instance LAST-MATCH-WINS by `isAllowedFor`.
//
// Enforcement is two-sided: the SQL row filter compiled by TypeConditionAlgebra and installed on each
// conditioned type’s `EntityEvents.queryFilter`, and the in-memory evaluator. Rules are keyed by TypeEntity
// id and the cache is async. The role default maps the boolean default-allowed to a simple Write / None.

export namespace TypeAuthLogic {
    let started = false;
    // The raw per-role `rules`, the role `graph`, and the merged
    // (role, typeId) → WithConditions memo, all resolved once in the factory and folded SYNCHRONOUSLY
    // thereafter. One instance lives behind the GlobalLazy, reset when a RuleType or Role is saved.
    export class TypeRulesCache {
        private readonly computed: ComputedCache<WithConditions<TypeAllowed>> = new Map();
        constructor(
            private readonly rules: Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>>,
            readonly graph: RoleGraph,
        ) { }

        /** The full WithConditions<TypeAllowed> for a type id and role. No current role → simple Write. A
         *  Part inherits its ROOT owner's allowance, collapsed to a condition-free scalar (no own rule). */
        getAllowed(typeId: PrimaryKey, caches: TypeCaches, roleKey?: string): WithConditions<TypeAllowed> {
            const rk = roleKey ?? AuthLogic.currentRoleKey();
            if (rk == null)
                return WithConditions.simple(TypeAllowed.Write);
            const ctor = caches.tryGetType(typeId);
            const rootCtor = ctor != null ? partRootCtor.get(ctor) : undefined;
            if (rootCtor != null)
                return collapseToScalar(this.getAllowed(caches.typeToId(rootCtor), caches, rk));
            const getDefaultSync = (r: string): WithConditions<TypeAllowed> =>
                WithConditions.simple(this.graph.getDefaultAllowed(r) ? TypeAllowed.Write : TypeAllowed.None);
            return computeAllowed<WithConditions<TypeAllowed>>(rk, typeId, this.rules, mergeType, getDefaultSync, this.computed, this.graph);
        }

        /** The value a role gets for a type with NO explicit rule: the
         *  merge of its direct parents' values, or the role default at a root role. */
        getAllowedBase(typeId: PrimaryKey, caches: TypeCaches, roleKey: string): WithConditions<TypeAllowed> {
            const parents = this.graph.relatedTo(roleKey);
            if (parents.size === 0)
                return WithConditions.simple(this.graph.getDefaultAllowed(roleKey) ? TypeAllowed.Write : TypeAllowed.None);
            return mergeType(this.graph.getMergeStrategy(roleKey), [...parents].map(p => this.getAllowed(typeId, caches, p)));
        }
    }
    let rulesLazy: ResetLazy<TypeRulesCache>;
    /** The two caches a row filter folds its answer from, demanded DURING the bind: cold, `stableValue`
     *  throws PromiseNotLoaded, the enclosing region loads exactly that one and binds again. So a filter can
     *  never quietly proceed without them — the alternative to awaiting is not fail-open, it is re-bind. */
    function foldingCaches(): { rules: TypeRulesCache; caches: TypeCaches } {
        return {
            rules: stableValue(rulesLazy.value()) as TypeRulesCache,
            caches: stableValue(TypeLogic.caches()) as TypeCaches,
        };
    }

    /**
     * The QUERY-AUDITOR verdicts for one table source, demanded the same way — the one thing here that is
     * not a cache. "Has the caller already constrained this type?" is about the query being translated, and
     * answering it reads the database, so it cannot happen in the binder; it happens in the region around
     * it, and the binder is re-run with the answer.
     *
     * MEMOISED per source NODE (and role), which is what makes the promise stable across attempts: the
     * enclosing bind simplifies ONCE, outside the region, so every attempt meets the same node. A WeakMap
     * keyed by it also means the memo dies with the query tree.
     */
    const auditsBySource = new WeakMap<Expression, Map<string, Promise<Map<TypeConditionSymbol, LambdaExpression>>>>();

    function auditedConditions(ctor: Function, roleKey: string, args: FilterQueryArgs | undefined)
        : Map<TypeConditionSymbol, LambdaExpression> | undefined {
        // Nothing to audit: the common case by far, and it costs one synchronous registry read.
        if (args == null || !TypeConditionLogic.hasQueryAuditorConditions(ctor))
            return undefined;
        // Exactly one source for this type is the auditable case. Several means the query reads it twice and
        // "the caller already constrained it" has no single answer, so the verdict stays unresolved — which
        // the algebra reads as "not satisfied". (Signum audits once per type and reaches the same place.)
        if (findQuerySources(args.fullQuery).filter(s => querySourceCtor(s) === ctor).length !== 1)
            return undefined;

        let byRole = auditsBySource.get(args.baseQuery);
        if (byRole == null)
            auditsBySource.set(args.baseQuery, byRole = new Map());
        const key = `${roleKey}|${ctor.name}`;
        let audit = byRole.get(key);
        if (audit == null)
            byRole.set(key, audit = markStable(TypeConditionLogic.auditQueryConditions(ctor, args)));
        return stableValue(audit) as Map<TypeConditionSymbol, LambdaExpression>;
    }
    // Part ctor → its ROOT owner's ctor (see PartOwnership). A Part inherits the root's allowance, so it
    // never gets its own rule and never shows in the grid. Keyed by CTOR (not typeId) because it is built at
    // schema.initialize — which also runs BEFORE generation, when a brand-new Part type has no TypeEntity id
    // yet; the id lookups are deferred to runtime (getAllowed), by when the caches are fully loaded.
    let partRootCtor = new Map<Function, Function>();
    // Back-reference Part ctor → the field-name chain to navigate UP to its non-Part root (e.g. Widget →
    // ["panel", "sample"]). Installed as a queryFilter on the Part so a STANDALONE `table(Part)` query is
    // gated by the root's TypeCondition (via-owner access never reaches this — the owner's collection
    // projection bypasses the queryFilter marker). Only conditioned roots produce an entry.
    let partChains = new Map<Function, string[]>();

    // Per-dimension access-summary providers (property/operation/query), registered by each dimension
    // logic at start (they already import TypeAuthLogic, so this avoids a back-import cycle). Each returns
    // the role's min/max allowance RANK over that dimension's rules for a type, or undefined if none.
    type SummaryFn = (typeName: string, roleKey: string) => Promise<{ min: number; max: number } | undefined>;
    const summaryProviders: { properties?: SummaryFn; operations?: SummaryFn; queries?: SummaryFn } = {};
    export function registerDimensionSummary(kind: "properties" | "operations" | "queries", fn: SummaryFn): void {
        summaryProviders[kind] = fn;
    }

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;
        // NO `withQuery()`: the rule ADMIN is a purpose-built page, not a SearchControl — and a Signum
        // database has no `basics.query` row for RuleType either.
        sb.include(RuleTypeEntity);
        // Type conditions: seed the TypeConditionSymbol table + register the framework predicates
        TypeConditionLogic.start(sb);
        TypeConditionLogic.registerCompile(UserEntity, UserTypeCondition.DeactivatedUsers, u => u.state === UserState.Deactivated);
        // Cache the rules + merged values,
        // resetting when a RuleType or Role is saved. (setTypeRulePack also resets explicitly for its deletes.)
        // globalLazy runs the factory in ExecutionMode.global, so its RuleType read is ungated — no explicit
        // Disable, and no re-entry into the row-filter provider during the load.
        rulesLazy = sb.globalLazy(async () => new TypeRulesCache(await loadRules(), await AuthLogic.roleGraph()),
            { invalidateWith: [RuleTypeEntity, RoleEntity] });
        AuthLogic.invalidateBlobWith(rulesLazy);   // the blob is filtered per role, so a rule change stales it
        AuthLogic.registerXmlExporter(exportXml);
        AuthLogic.registerXmlImporter(importXml);
        // Enforcement. The save gate is installed now; the row-read FILTER goes on each CONDITIONED type's
        // EntityEvents.queryFilter so the LINQ binder applies it to EVERY query (retrieve, dynamic query,
        // navigation). The binder is sync, but the filter is not starved: it DEMANDS what it needs while
        // binding (the rules and type caches, the auditor verdicts for its own source) and the region around
        // the bind loads it and binds again. The per-type hooks are installed in a schema.initializing hook —
        // only once ALL conditions are registered (app conditions register after this start).
        preSaveGates.push(authSaveGate);
        postRetrieveGates.push(authRetrieveGate);
        // The contextual menu of a SearchControl
        // asks whether ANY of the selected rows is read-only for this role, and hides the operations that
        // would fail anyway. altea core owns the seam (OperationLogic.onAnyReadonly); this is its one filler.
        OperationLogic.onAnyReadonly(anySelectedReadonly);
        sb.schema.initializing.push(() => {
            for (const ctor of TypeConditionLogic.types())
                sb.schema.entityEvents(ctor as Type<Entity>).queryFilter.push(authQueryFilterHook);
            // Derive part → root ownership (structural — throws on a forbidden multi-owner Part).
            partRootCtor = computePartRoots(sb.schema);
            // Standalone-part row security: for each back-reference Part whose ROOT is conditioned, install a
            // queryFilter that rebases the root's TypeCondition onto the Part via its back-reference chain, so
            // a direct `table(Part)` query is restricted exactly as the root is. Only conditioned roots matter
            // (an unconditioned root's Read is a plain scalar — no per-row predicate to rebase).
            partChains = partParentChains(sb.schema);
            const conditioned = new Set(TypeConditionLogic.types());
            for (const [partCtor, chain] of partChains) {
                const rootCtor = partRootCtor.get(partCtor);
                if (rootCtor != null && conditioned.has(rootCtor) && chain.length > 0)
                    sb.schema.entityEvents(partCtor as Type<Entity>).queryFilter.push(partAuthQueryFilterHook(rootCtor, chain));
            }
            // Retrieve-time DB-only TypeCondition fill: register
            // ONE additional binding per DB-only condition on each conditioned type, so the LINQ binder folds
            // the condition's boolean straight into the retrieval SELECT (0 extra queries) and the projector
            // caches it per row — letting a later SYNCHRONOUS inTypeCondition (the property serializer, an
            // in-memory row check) read it. In-memory (registerCompile) conditions evaluate live and need no
            // binding, so the common all-registerCompile case registers nothing. The value is computed
            // unconditionally — it is the raw predicate result, independent of role / auth
            // state — so there's no gating here (and, being inline in the SELECT, no fill query to recurse).
            for (const ctor of TypeConditionLogic.types()) {
                const elementType = new ClassType(ctor);
                const specs = sb.schema.entityEvents(ctor as Type<Entity>).additionalBindings;
                for (const tc of TypeConditionLogic.conditionsFor(ctor)) {
                    if (TypeConditionLogic.hasSyncInMemoryCondition(ctor, tc))
                        continue;
                    // A QUERY-AUDITOR condition has no predicate to fold into the SELECT: its answer is
                    // about the caller's query, not the row. Its per-instance value comes from
                    // fillTypeConditions instead (see TypeConditionLogic).
                    if (TypeConditionLogic.isQueryAuditor(ctor, tc))
                        continue;
                    specs.push({
                        valueLambda: conditionValueLambda(ctor, elementType, tc),
                        set: (e, v) => TypeConditionLogic.setCached(e as Entity, tc, v === true || v === 1),
                    });
                }
            }
        });
    }

    /**
     * Per selected TYPE: fully writable → no; nothing above Read → yes; otherwise the CONDITIONS decide,
     * counted in SQL. SET-BASED on purpose: a role WITH conditions on a type is the normal case, not the
     * exception, so "one query per selected row" would cost a per-right-click query per selected row.
     *
     * The row filter cannot be suppressed for a single query — which is what Signum's
     * `DisableQueryFilter()` buys it — so the READ filter applies to this count as well. It
     * changes nothing for the caller — the lites come from a search that was already read-filtered, so every
     * row of the selection is readable — but a hand-built lite of an unreadable row would be counted as
     * writable rather than as read-only.
     */
    async function anySelectedReadonly(lites: Lite<Entity>[]): Promise<boolean> {
        if (!AuthLogic.isEnabled() || AuthLogic.currentRoleKey() == null)
            return false;

        const byType = new Map<Type<Entity>, Lite<Entity>[]>();
        for (const lite of lites) {
            const ctor = lite.entityType as Type<Entity>;
            let group = byType.get(ctor);
            if (group == null) byType.set(ctor, group = []);
            group.push(lite);
        }

        for (const [ctor, group] of byType) {
            const wc = await getAllowed((await TypeLogic.caches()).typeToId(ctor));
            if (minBound(wc, true) >= TypeAllowedBasic.Write)
                continue;
            if (maxBound(wc, true) <= TypeAllowedBasic.Read)
                return true;
            // The conditions decide row by row, so ASK THE DATABASE: compile the role's rules into the same
            // boolean predicate the row filter is made of, at the WRITE level, and count the selected rows
            // that fail it: one `SELECT COUNT(*) … WHERE id IN (…) AND NOT(<algebra>)`.
            // Built at expression level because `Query.count` takes a `Quoted` (a lambda the transformer
            // stamped at BUILD time) and this predicate only exists at runtime; the CallExpression below is
            // what that method builds anyway.
            const ids = group.map(l => l.id);
            const q = table(ctor).filter((e: Entity) => ids.includes(e.id));
            const writable = buildAuthFilter(ctor, q.elementType, wc, TypeAllowedBasic.Write, true);
            if (writable === "all")
                continue;
            if (writable === "none")
                return true;

            const notWritable = new LambdaExpression(writable.parameters, new UnaryExpression("!", writable.body));
            const count = new CallExpression(
                new PropertyExpression(q.expression, "count"), [notWritable], LiteralType.number);

            if ((await q.translator.execute(count) as number) > 0)
                return true;
        }
        return false;
    }

    /** True for a Part that inherits its owner's rules (hidden from the Type-Auth grid). */
    export function isInheritedPart(typeId: PrimaryKey, caches: TypeCaches): boolean {
        const ctor = caches.tryGetType(typeId);
        return ctor != null && partRootCtor.has(ctor);
    }

    /** The transitive owned-part closure for an OWNER type. Parts are real entities here and never appear
     *  in the Type-Auth grid. Returns [ownerCleanName, ...partCleanNames],
     *  parts ordered by ownership DEPTH then name, so a per-type dimension drill-in (property/operation/
     *  query) can render one rule table per type in the SAME modal (storage stays per-type). A type that
     *  owns no parts returns just [ownerCleanName]. */
    export function ownedPartClosure(ownerTypeName: string): string[] {
        const parts: { name: string; depth: number }[] = [];
        for (const [partCtor, rootCtor] of partRootCtor) {
            if (cleanTypeName(rootCtor) !== ownerTypeName)
                continue;
            parts.push({ name: cleanTypeName(partCtor), depth: partChains.get(partCtor)?.length ?? 1 });
        }
        parts.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
        return [ownerTypeName, ...parts.map(p => p.name)];
    }

    // A Part's inherited allowance = its root owner's, COLLAPSED to a condition-free scalar (the role's best
    // case on the root). Safe because row-level gating already happened at the owner: a Part is reached only
    // through its (already-filtered) owner, so it needs no conditions of its own — and collapsing avoids
    // evaluating the root's owner-predicate against a Part instance (which it isn't).
    function collapseToScalar(rootWC: WithConditions<TypeAllowed>): WithConditions<TypeAllowed> {
        return WithConditions.simple(typeAllowedCreate(maxDB(rootWC), maxUI(rootWC)));
    }

    // Row-read filter, installed on each conditioned type's EntityEvents.queryFilter, and run by the binder
    // when it meets THAT table source. Synchronous, like every queryFilter hook — and self-sufficient: it
    // demands the caches it folds the role's allowance from, and the auditor verdicts for this source, so a
    // query pays for the types it actually reads. Nothing is resolved in advance for it any more.
    function authQueryFilterHook(ctx: { ctor: Function; elementType: RuntimeType; args: FilterQueryArgs | undefined }): LambdaExpression | undefined {
        const rk = AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return undefined;
        const { rules, caches } = foldingCaches();
        const typeId = caches.tryTypeToId(ctx.ctor);
        if (typeId == null)
            return undefined;
        return authFilterLambda(
            buildAuthFilter(ctx.ctor, ctx.elementType, rules.getAllowed(typeId, caches, rk),
                TypeAllowedBasic.Read, true, auditedConditions(ctx.ctor, rk, ctx.args)),
            ctx.elementType);
    }

    // Standalone-part row filter (installed per back-reference Part in `start`): rebase the ROOT owner's
    // Read filter onto the Part by navigating the back-reference `chain` up to the root, so a direct
    // `table(Part)` query is restricted exactly as the root is. SYNCHRONOUS, like authQueryFilterHook —
    // reads the same async-resolved ConditionsByType for the ROOT's id. No root entry (auth off / no role)
    // or the root reduces to "all" → no filter.
    function partAuthQueryFilterHook(rootCtor: Function, chain: readonly string[]) {
        return (ctx: { ctor: Function; elementType: RuntimeType; args: FilterQueryArgs | undefined }): LambdaExpression | undefined => {
            const rk = AuthLogic.currentRoleKey();
            if (rk == null || !AuthLogic.isEnabled())
                return undefined;
            // A root with no conditions is the same "no filter" answer it always was.
            if (TypeConditionLogic.conditionsFor(rootCtor).length === 0)
                return undefined;
            const { rules, caches } = foldingCaches();
            const rootTypeId = caches.tryTypeToId(rootCtor);
            if (rootTypeId == null)
                return undefined;
            // The audit is about the ROOT's own sources, and this query's source is the PART — so there is
            // none to give it (the same answer the root got when it was not in the query at all).
            const rootFilter = buildAuthFilter(rootCtor, new ClassType(rootCtor),
                rules.getAllowed(rootTypeId, caches, rk), TypeAllowedBasic.Read, true, undefined);
            return rebasePartFilter(rootFilter, ctx.elementType, chain);
        };
    }

    // Write gate, per instance: block saving a row that a type CONDITION
    // denies writing. Scoped to conditioned types where the role CAN write some rows (max DB >= Write) — a
    // type the role can't write at all is an operation-auth concern (not ported), so we don't block those
    // here (that would break legitimate self-service saves on Read-only types). No current role → no gate.
    async function authSaveGate(entities: Entity[]): Promise<void> {
        const rk = AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return;
        // Batch-fill the DB-only conditions of the conditioned entities being saved up front — one query
        // per type — so the per-instance isAllowedFor below
        // reads cached values. (A brand-new row isn't in the DB yet, so its DB-only conditions resolve
        // false — the same limitation as any pre-write gate; in-memory conditions evaluate live regardless.)
        const byCtor = new Map<Function, Entity[]>();
        for (const e of entities) {
            if (!TypeConditionLogic.hasDbOnlyConditions(e.constructor)) continue;
            let g = byCtor.get(e.constructor);
            if (g == null) { g = []; byCtor.set(e.constructor, g); }
            g.push(e);
        }
        for (const group of byCtor.values())
            await TypeConditionLogic.fillTypeConditions(group);

        for (const e of entities) {
            const ctor = e.constructor as Function;
            if (TypeConditionLogic.conditionsFor(ctor).length === 0)
                continue;
            const wc = await getAllowed((await TypeLogic.caches()).typeToId(ctor), rk);
            if (maxBound(wc, false) < TypeAllowedBasic.Write)
                continue;
            if (!(await isAllowedFor(e, TypeAllowedBasic.Write, false, rk)))
                throw new UnauthorizedAccessException(`Not authorized to save ${ctor.name} '${String(e.id)}' — denied by a type condition`);
        }
    }

    // Read gate: deny retrieving a type the current role cannot Read
    // at all (max DB access < Read). No current role / auth off / global mode → no gate (AuthLogic.isEnabled
    // folds in ExecutionMode.global, so the cache-load's internal reads are ungated). Checked ONCE per
    // distinct type — every row of a type shares the type-read bound; per-row TypeConditions are enforced by
    // the queryFilter, not here. A type not registered in TypeLogic (enum side-table / view) is not
    // type-auth-gated, so it is skipped.
    async function authRetrieveGate(entities: Entity[]): Promise<void> {
        const rk = AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return;
        const checked = new Set<Function>();
        for (const e of entities) {
            const ctor = e.constructor as Function;
            if (checked.has(ctor))
                continue;
            checked.add(ctor);
            let typeId: PrimaryKey;
            try { typeId = (await TypeLogic.caches()).typeToId(ctor); } catch { continue; }
            const wc = await getAllowed(typeId, rk);
            if (maxBound(wc, false) < TypeAllowedBasic.Read)
                throw new UnauthorizedAccessException(`Not authorized to retrieve ${ctor.name}`);
        }
    }

    // Explicit reset (for setTypeRulePack, whose deletes don't fire the `saved` event the GlobalLazy
    // listens to). Saves are auto-handled by the GlobalLazy's invalidateWith.
    export function invalidate(): void {
        rulesLazy?.reset();
    }

    // Build the raw per-role rules from the DB (the GlobalLazy factory — caching/invalidation is the lazy's job).
    async function loadRules(): Promise<Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>>> {
        const rows = await table(RuleTypeEntity).toArray() as RuleTypeEntity[];
        // id -> the shared (interned) TypeConditionSymbol, to resolve each condition row's Lite reference.
        const symbolById = new Map((await SymbolLogic.cache(TypeConditionSymbol)).symbols().map(s => [String(s.id), s]));
        const map = new Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>>();
        for (const row of rows) {
            const roleKey = row.role.key();
            let inner = map.get(roleKey);
            if (inner == null) { inner = new Map(); map.set(roleKey, inner); }
            inner.set(row.resource.id, toWithConditions(row, symbolById));
        }
        return map;
    }

    // A persisted RuleTypeEntity (fallback + its owned condition rows) → the immutable runtime value. The
    // condition rows are ordered by their `order` column; each row's symbol set
    // resolves its Lite<TypeConditionSymbol> references back to the shared symbol instances.
    function toWithConditions(row: RuleTypeEntity, symbolById: Map<string, TypeConditionSymbol>): WithConditions<TypeAllowed> {
        const conditionRules = [...row.conditionRules]
            .orderBy(a => a.rowOrder)
            .map(cr => new ConditionRule<TypeAllowed>(
                cr.conditions.map(c => {
                    const s = symbolById.get(String(c.symbol.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(c.symbol.id)} is not registered`);
                    return s;
                }),
                cr.allowed));
        return new WithConditions<TypeAllowed>(row.fallback, conditionRules);
    }

    const mergeType = (strategy: MergeStrategy, baseValues: WithConditions<TypeAllowed>[]): WithConditions<TypeAllowed> =>
        mergeTypeConditions(strategy, baseValues);

    /** The loaded type-rule cache — awaited by dimensions that fold over
     *  the type allowance synchronously (property ceilings, query/operation type-based defaults) and by the
     *  serialization-auth context. */
    export function rulesCache(): Promise<TypeRulesCache> {
        return rulesLazy.value();
    }

    /** The full WithConditions<TypeAllowed> for a type id and role. No current role → simple Write. */
    export async function getAllowed(typeId: PrimaryKey, roleKey?: string): Promise<WithConditions<TypeAllowed>> {
        // The type↔id snapshot is resolved HERE, per call, rather than captured inside the rules cache: the
        // rules are invalidated by a RuleType/Role save, the type ids by a schema sync, and a cache holding
        // a snapshot of the other would go stale on the wrong signal.
        return (await rulesLazy.value()).getAllowed(typeId, await TypeLogic.caches(), roleKey);
    }

    /** The type's configured type-condition SETS for a role (each an AND-ed TypeConditionSymbol set), from
     *  the role's merged type rule condition rows. These are the selectable "slices" in the property /
     *  operation rule editors. Empty when the type / role
     *  has no condition rules. (A Part collapses to a scalar with no conditions → empty; a part's property
     *  rules are edited on the Fallback slice only.) */
    export async function conditionSetsForType(typeId: PrimaryKey, roleKey?: string): Promise<TypeConditionSymbol[][]> {
        const wc = await getAllowed(typeId, roleKey);
        return wc.conditionRules.map(cr => [...cr.typeConditions]);
    }

    /** The role's coarse MAX UI-read allowance for a type —
     *  None/Read/Write. Shipped per type in the reflection blob so the client can render a `None` type's
     *  EntityLink as text (not a link). */
    export async function maxTypeAllowedUI(typeId: PrimaryKey, roleKey?: string): Promise<TypeAllowedBasic> {
        return maxBound(await getAllowed(typeId, roleKey), true);
    }

    /** Coarse "can this role reach `requested` for this type AT ALL" — used by the
     *  reflection-blob filter to decide type/query visibility. A conditionally-readable type is visible. */
    export async function isAllowedForType(
        typeId: PrimaryKey,
        requested: TypeAllowedBasic,
        userInterface: boolean,
        roleKey?: string,
    ): Promise<boolean> {
        const wc = await getAllowed(typeId, roleKey);
        return maxBound(wc, userInterface) >= requested;
    }

    // The per-INSTANCE evaluation, LAST-MATCH-WINS:
    // Min/Max short-circuits, then iterate the condition rules IN REVERSE and return on the first whose
    // symbol set ALL holds for the entity (in-memory predicates), else the fallback. Used by the save gate
    // + the in-memory branch of the row filter. No current role (auth off) → allowed.
    export async function isAllowedFor(entity: Entity, requested: TypeAllowedBasic, userInterface: boolean, roleKey?: string): Promise<boolean> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return true;
        const tac = await getAllowed((await TypeLogic.caches()).typeToId(entity.constructor), rk);
        const min = minBound(tac, userInterface);
        if (requested <= min)
            return true;
        const max = maxBound(tac, userInterface);
        if (max < requested)
            return false;
        // Some of this role's condition rules may reference DB-only conditions (no in-memory predicate);
        // pre-evaluate them against this entity in SQL so the sync inTypeCondition below can read the result
        // (a no-op when every condition is registerCompile'd — the common case).
        // A QUERY-AUDITOR condition is filled here too, from its async per-instance predicate.
        await TypeConditionLogic.fillTypeConditions([entity]);
        for (let i = tac.conditionRules.length - 1; i >= 0; i--) {
            const cond = tac.conditionRules[i];
            if (cond.typeConditions.every(tc => TypeConditionLogic.inTypeCondition(entity, tc)))
                return typeAllowedGet(cond.allowed, userInterface) >= requested;
        }
        return typeAllowedGet(tac.fallback, userInterface) >= requested;
    }

    /**
     * May the current
     * role reach THIS ROW, asked of a lite rather than a loaded entity.
     *
     * Compile the role's rules into the same predicate the row filter is made of and ask the DATABASE
     * whether that one row passes. Built at expression level for the same reason `anySelectedReadonly` is
     * — the predicate only exists at runtime — and run in `ExecutionMode.global`, so the read is not
     * itself row-filtered.
     *
     * `args` is passed through to the TARGET type's own QUERY-AUDITOR conditions: "may I read this row"
     * can itself depend on how the row was asked for, and the row filter would evaluate those conditions
     * too.
     */
    export async function isAllowedForLite(
        lite: Lite<Entity>,
        requested: TypeAllowedBasic,
        userInterface: boolean,
        args?: FilterQueryArgs,
        roleKey?: string,
    ): Promise<boolean> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return true;

        const ctor = lite.entityType as Type<Entity>;
        const typeId = (await TypeLogic.caches()).typeToId(ctor);
        const wc = await getAllowed(typeId, rk);
        if (minBound(wc, userInterface) >= requested)
            return true;
        if (maxBound(wc, userInterface) < requested)
            return false;

        const audited = args != null && TypeConditionLogic.hasQueryAuditorConditions(ctor)
            ? await TypeConditionLogic.auditQueryConditions(ctor, args)
            : undefined;

        return await ExecutionMode.global(async () => {
            const q = table(ctor).filter((e: Entity) => e.is(lite));
            const filter = buildAuthFilter(ctor, q.elementType, wc, requested, userInterface, audited);
            if (filter === "all")
                return true;
            if (filter === "none")
                return false;
            const some = new CallExpression(
                new PropertyExpression(q.expression, "some"), [filter], LiteralType.boolean);
            return (await q.translator.execute(some)) === true;
        });
    }

    // The value a role would get for a type with NO explicit rule.
    export async function getAllowedBase(typeId: PrimaryKey, roleKey: string): Promise<WithConditions<TypeAllowed>> {
        return (await rulesLazy.value()).getAllowedBase(typeId, await TypeLogic.caches(), roleKey);
    }

    const symbolLite = (s: TypeConditionSymbol): Lite<TypeConditionSymbol> => TypeConditionSymbol.newLite(s.id, s.key);

    // Runtime WithConditions → the mutable transport model.
    function toModel(wc: WithConditions<TypeAllowed>): WithConditionsModel {
        return WithConditionsModel.create({
            fallback: wc.fallback,
            conditionRules: wc.conditionRules.map(cr => ConditionRuleModel.create({
                typeConditions: cr.typeConditions.map(symbolLite),
                allowed: cr.allowed,
            })),
        });
    }

    // Edited model → runtime WithConditions, resolving each condition's symbol Lite
    // back to the shared symbol. Used to compare allowed vs allowedBase (redundant-rule detection).
    function fromModel(model: WithConditionsModel, symbolById: Map<string, TypeConditionSymbol>): WithConditions<TypeAllowed> {
        return new WithConditions<TypeAllowed>(model.fallback, model.conditionRules.map(cr =>
            new ConditionRule<TypeAllowed>(
                cr.typeConditions.map(lite => {
                    const s = symbolById.get(String(lite.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(lite.id)} is not registered`);
                    return s;
                }),
                cr.allowed)));
    }

    // The admin pack: every type with the role's effective `allowed` and its
    // inherited `allowedBase` (each a full WithConditionsModel: fallback + condition rules), plus the
    // `availableConditions` the type registered (so the UI can offer them). The resource Lite carries the
    // clean name as its toStr for display.
    export async function getTypeRulePack(roleId: PrimaryKey): Promise<TypeRulePack> {
        const role = await table(RoleEntity).filter(r => r.id == roleId).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${roleId}' not found`);
        const roleKey = role.toLite().key();
        // typeId -> the symbols registered for that type (only types with conditions appear).
        const caches = await TypeLogic.caches();
        const availableByType = new Map<PrimaryKey, TypeConditionSymbol[]>(
            TypeConditionLogic.types().map(ctor => [caches.typeToId(ctor), TypeConditionLogic.conditionsFor(ctor)]));
        const rules: TypeAllowedRule[] = [];
        for (const t of await table(TypeEntity).toArray() as TypeEntity[]) {
            // Hide Parts (they inherit their owner — see PartOwnership) and enum side-tables. A SharedPart
            // is NOT a partRootCtor key, so it stays visible with its own manual rules.
            const ctor = caches.tryGetType(t.id);
            if ((ctor != null && partRootCtor.has(ctor)) || isEnumEntityType(ctor))
                continue;
            // The owner + its associated parts (altea-only; [owner, ...parts]). The min/max coloring folds
            // over the WHOLE closure, not just the main entity, so a row's summary reflects the parts a
            // drill-in would edit too (matching the modal that opens on click).
            const closure = ownedPartClosure(t.cleanName);
            const summary = async (fn: SummaryFn | undefined): Promise<DimensionSummaryModel> => {
                if (fn == null)
                    return DimensionSummaryModel.create({ min: toInt(-1), max: toInt(-1) });
                let min: number | undefined, max: number | undefined;
                for (const name of closure) {
                    const s = await fn(name, roleKey);
                    if (s == null) continue;
                    min = min == null ? Number(s.min) : Math.min(min, Number(s.min));
                    max = max == null ? Number(s.max) : Math.max(max, Number(s.max));
                }
                return DimensionSummaryModel.create({ min: toInt(min ?? -1), max: toInt(max ?? -1) });
            };
            rules.push(TypeAllowedRule.create({
                resource: TypeEntity.newLite(t.id, t.cleanName),
                allowed: toModel(await getAllowed(t.id, roleKey)),
                allowedBase: toModel(await getAllowedBase(t.id, roleKey)),
                availableConditions: (availableByType.get(t.id) ?? []).map(symbolLite),
                ownedParts: closure.slice(1), // [owner, ...parts] → just the parts
                propertiesSummary: await summary(summaryProviders.properties),
                operationsSummary: await summary(summaryProviders.operations),
                queriesSummary: await summary(summaryProviders.queries),
                packageName: (ctor != null ? getLocation(ctor.name)?.packageName : undefined) ?? "",
            }));
        }
        rules.sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()));
        return TypeRulePack.create({ role: role.toLite(), strategy: MergeStrategy[role.mergeStrategy], rules });
    }

    // Persist the pack: a value equal to its inherited base is redundant
    // (delete the explicit rule); otherwise upsert a RuleType with the fallback + condition rows. Then
    // invalidate the cache. The condition rows (RuleTypeConditionEntity + its symbol junction) are owned,
    // so replacing the array orphan-deletes the old rows and inserts the new on save.
    export async function setTypeRulePack(pack: TypeRulePack): Promise<void> {
        const role = await table(RoleEntity).filter(r => r.id == pack.role.id).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${pack.role.id}' not found`);
        const roleLite = role.toLite();
        const symbolById = new Map((await SymbolLogic.cache(TypeConditionSymbol)).symbols().map(s => [String(s.id), s]));
        const current = await table(RuleTypeEntity).filter(rt => rt.role == roleLite).toArray() as RuleTypeEntity[];
        const currentByType = new Map(current.map(rt => [String(rt.resource.id), rt]));

        for (const r of pack.rules) {
            const existing = currentByType.get(String(r.resource.id));
            const isRedundant = fromModel(r.allowed, symbolById).equals(fromModel(r.allowedBase, symbolById));
            if (isRedundant) {
                if (existing != null)
                    await existing.delete();
                continue;
            }
            const rt = existing ?? RuleTypeEntity.create({
                role: roleLite,
                resource: TypeEntity.newLite(r.resource.id, r.resource.toString()),
            });
            rt.fallback = r.allowed.fallback;
            rt.conditionRules = r.allowed.conditionRules.map((cr, i) => RuleTypeConditionEntity.create({
                rowOrder: toInt(i),
                allowed: cr.allowed,
                conditions: cr.typeConditions.map(lite => RuleTypeConditionEntity_Condition.create({ symbol: lite })),
            }));
            await rt.save();
        }
        invalidate();
    }

    // ---- AuthRules XML ------------------------------------------------------------------------
    async function exportXml(ctx: AuthExportCtx): Promise<{ name: string; content: unknown }> {
        const typeName = new Map((await table(TypeEntity).toArray() as TypeEntity[]).map(t => [String(t.id), t.cleanName]));
        const condKey = new Map((await SymbolLogic.cache(TypeConditionSymbol)).symbols().map(s => [String(s.id), s.key]));
        const byRole = groupByRole(await table(RuleTypeEntity).toArray() as RuleTypeEntity[]);
        return {
            name: "Types",
            content: section("Type", ctx.orderedRoleKeys, ctx.roleName, byRole, r => {
                const conds = conditionsXml(r.conditionRules, v => TypeAllowed[v], id => condKey.get(String(id)) ?? String(id));
                return {
                    ...attrs({ Resource: typeName.get(String(r.resource.id)) ?? String(r.resource.id), Allowed: TypeAllowed[r.fallback] }),
                    ...(conds.length ? { Condition: conds } : {}),
                };
            }),
        };
    }

    // Deep-clone a WithConditionsModel (resetting a rule to its base must not alias the base graph).
    const cloneModel = (m: WithConditionsModel): WithConditionsModel => WithConditionsModel.create({
        fallback: m.fallback,
        conditionRules: m.conditionRules.map(cr => ConditionRuleModel.create({ allowed: cr.allowed, typeConditions: [...cr.typeConditions] })),
    });

    async function importXml(auth: Record<string, unknown>, ctx: AuthImportCtx): Promise<void> {
        for (const rb of (auth.Types as { Role?: XmlRoleBlock[] } | undefined)?.Role ?? []) {
            const role = ctx.noteRole(rb.Name);
            if (role == null) continue;
            const byResource = new Map((rb.Type ?? []).map(r => [ctx.applyType(r.Resource), r]));
            const pack = await getTypeRulePack(role.id);
            for (const rule of pack.rules) {
                const x = byResource.get(rule.resource.toString());
                rule.allowed = x != null
                    ? WithConditionsModel.create({
                        fallback: parseEnum(TypeAllowed, x.Allowed),
                        conditionRules: (x.Condition ?? []).map(c => ConditionRuleModel.create({
                            allowed: parseEnum(TypeAllowed, c.Allowed),
                            typeConditions: condLites(c, ctx).map(l => TypeConditionSymbol.newLite(l.id, l.key)),
                        })),
                    })
                    : cloneModel(rule.allowedBase);
            }
            await setTypeRulePack(pack);
        }
    }
}
