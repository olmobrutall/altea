import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import type { LambdaExpression } from "@altea/altea/server/linq/expressions";
import { ClassType, type RuntimeType } from "@altea/altea/server/runtimeTypes";
import type { QueryFilterContext } from "@altea/altea/server/schema/entityEvents";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeLogic } from "@altea/altea/server/typeLogic";
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
import { computeAllowed, type ComputedCache } from "./AuthCache";
import { section, groupByRole, attrs, conditionsXml, condLites, parseEnum, type AuthImportCtx, type XmlRoleBlock } from "./AuthRulesXml";
import type { AuthExportCtx } from "./AuthLogic";

// Port of Signum's TypeAuthLogic (Rules/TypeAuthLogic.cs + .Conditions.cs) — a role's access to an entity
// TYPE, now with ROW-LEVEL type conditions. A role's allowed for a type is a `WithConditions<TypeAllowed>`
// (a fallback + ordered condition rules), merged across the role graph by the 2^n TypeConditionMerger.
// `isAllowedFor(entity, …)` evaluates it against a concrete instance (last-match-wins). The compile-to-SQL
// row filter + save gate are Phase D.
//
// altea divergences: rules keyed by TypeEntity id; async cache (no GlobalLazy). Merge is the faithful
// truth-table merger (TypeConditionMerger). The role default maps the boolean default-allowed to a simple
// Write / None WithConditions.

export namespace TypeAuthLogic {
    let started = false;
    // Signum's AuthCache as a CLASS: the raw per-role `rules`, the role `graph`, and the merged
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
        getAllowed(typeId: PrimaryKey, roleKey?: string): WithConditions<TypeAllowed> {
            const rk = roleKey ?? AuthLogic.currentRoleKey();
            if (rk == null)
                return WithConditions.simple(TypeAllowed.Write);
            const ctor = TypeLogic.tryGetType(typeId);
            const rootCtor = ctor != null ? partRootCtor.get(ctor) : undefined;
            if (rootCtor != null)
                return collapseToScalar(this.getAllowed(TypeLogic.typeToId(rootCtor), rk));
            const getDefaultSync = (r: string): WithConditions<TypeAllowed> =>
                WithConditions.simple(this.graph.getDefaultAllowed(r) ? TypeAllowed.Write : TypeAllowed.None);
            return computeAllowed<WithConditions<TypeAllowed>>(rk, typeId, this.rules, mergeType, getDefaultSync, this.computed, this.graph);
        }

        /** The value a role gets for a type with NO explicit rule (Signum's AuthCache.GetAllowedBase): the
         *  merge of its direct parents' values, or the role default at a root role. */
        getAllowedBase(typeId: PrimaryKey, roleKey: string): WithConditions<TypeAllowed> {
            const parents = this.graph.relatedTo(roleKey);
            if (parents.size === 0)
                return WithConditions.simple(this.graph.getDefaultAllowed(roleKey) ? TypeAllowed.Write : TypeAllowed.None);
            return mergeType(this.graph.getMergeStrategy(roleKey), [...parents].map(p => this.getAllowed(typeId, p)));
        }
    }
    let rulesLazy: ResetLazy<TypeRulesCache>;
    // The current role's per-conditioned-type WithConditions, resolved ON DEMAND per query (not kept warm):
    // an async provider builds it into the opaque QueryFilterContext under this key, and the SYNC binder
    // hook reads it back. Signum keeps its RoleAllowedCache permanently warm; altea (no sync DB) instead
    // pays one async resolve per query.
    const QUERY_FILTER_KEY = "altea-auth:typeConditions";
    type ConditionsByType = Map<PrimaryKey, WithConditions<TypeAllowed>>;
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
        sb.include(RuleTypeEntity).withQuery();
        // Type conditions: seed the TypeConditionSymbol table + register the framework predicates
        // (Signum's TypeAuthLogic.Start → TypeConditionLogic.Start + the DeactivatedUsers RegisterCompile).
        TypeConditionLogic.start(sb);
        TypeConditionLogic.registerCompile(UserEntity, UserTypeCondition.DeactivatedUsers, u => u.state === UserState.Deactivated);
        // Signum's `sb.GlobalLazy(rules, InvalidateWith(RuleType, Role))`: cache the rules + merged values,
        // resetting when a RuleType or Role is saved. (setTypeRulePack also resets explicitly for its deletes.)
        // globalLazy runs the factory in ExecutionMode.global, so its RuleType read is ungated — no explicit
        // Disable, and no re-entry into the row-filter provider during the load.
        rulesLazy = sb.globalLazy(async () => new TypeRulesCache(await loadRules(), await AuthLogic.roleGraph()),
            { invalidateWith: [RuleTypeEntity, RoleEntity] });
        AuthLogic.registerXmlExporter(exportXml);
        AuthLogic.registerXmlImporter(importXml);
        // Enforcement. The save gate (Signum's Schema_Saving) is installed now. The row-read FILTER
        // (Signum's FilterQuery) goes on each CONDITIONED type's EntityEvents.queryFilter so the LINQ binder
        // applies it to EVERY query (retrieve, dynamic query, navigation). The binder is sync, so the data it
        // needs is resolved ASYNC before each translation: register an async provider that builds the current
        // role's conditions into the opaque QueryFilterContext (no permanently-warm cache). The per-type sync
        // hooks are installed in a schema.initializing hook — only once ALL conditions are registered (app
        // conditions register after this start).
        preSaveGates.push(authSaveGate);
        postRetrieveGates.push(authRetrieveGate);
        sb.schema.queryFilterProviders.set(QUERY_FILTER_KEY, buildCurrentRoleConditions);
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
            // Retrieve-time DB-only TypeCondition fill (Signum's _typeConditions RegisterBinding): register
            // ONE additional binding per DB-only condition on each conditioned type, so the LINQ binder folds
            // the condition's boolean straight into the retrieval SELECT (0 extra queries) and the projector
            // caches it per row — letting a later SYNCHRONOUS inTypeCondition (the property serializer, an
            // in-memory row check) read it. In-memory (registerCompile) conditions evaluate live and need no
            // binding, so the common all-registerCompile case registers nothing. The value is computed
            // unconditionally (like Signum) — it's the raw predicate result, independent of role / auth
            // state — so there's no gating here (and, being inline in the SELECT, no fill query to recurse).
            for (const ctor of TypeConditionLogic.types()) {
                const elementType = new ClassType(ctor);
                const specs = sb.schema.entityEvents(ctor as Type<Entity>).additionalBindings;
                for (const tc of TypeConditionLogic.conditionsFor(ctor)) {
                    if (TypeConditionLogic.hasInMemoryCondition(ctor, tc))
                        continue;
                    specs.push({
                        valueLambda: conditionValueLambda(ctor, elementType, tc),
                        set: (e, v) => TypeConditionLogic.setCached(e as Entity, tc, v === true || v === 1),
                    });
                }
            }
        });
    }

    /** True for a Part that inherits its owner's rules (hidden from the Type-Auth grid). */
    export function isInheritedPart(typeId: PrimaryKey): boolean {
        const ctor = TypeLogic.tryGetType(typeId);
        return ctor != null && partRootCtor.has(ctor);
    }

    /** The transitive owned-part closure for an OWNER type (no Signum analog — altea Parts are real
     *  entities that never appear in the Type-Auth grid). Returns [ownerCleanName, ...partCleanNames],
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

    // Row-read filter (Signum's TypeAuthLogic_FilterQuery), installed on each conditioned type's
    // EntityEvents.queryFilter. SYNCHRONOUS (the binder is sync): reads THIS module's entry from the opaque
    // QueryFilterContext the engine resolved (async, via buildCurrentRoleConditions) BEFORE translation —
    // the current role's typeId → WithConditions map — never the DB. No entry (no role / auth disabled) or
    // no condition for this type → no filter (undefined).
    function authQueryFilterHook(ctx: { ctor: Function; elementType: RuntimeType; filterContext: QueryFilterContext }): LambdaExpression | undefined {
        const map = ctx.filterContext.get(QUERY_FILTER_KEY) as ConditionsByType | undefined;
        const wc = map?.get(TypeLogic.typeToId(ctx.ctor));
        if (wc == null)
            return undefined;
        return authFilterLambda(buildAuthFilter(ctx.ctor, ctx.elementType, wc, TypeAllowedBasic.Read, true), ctx.elementType);
    }

    // Standalone-part row filter (installed per back-reference Part in `start`): rebase the ROOT owner's
    // Read filter onto the Part by navigating the back-reference `chain` up to the root, so a direct
    // `table(Part)` query is restricted exactly as the root is. SYNCHRONOUS, like authQueryFilterHook —
    // reads the same async-resolved ConditionsByType for the ROOT's id. No root entry (auth off / no role)
    // or the root reduces to "all" → no filter.
    function partAuthQueryFilterHook(rootCtor: Function, chain: readonly string[]) {
        return (ctx: { ctor: Function; elementType: RuntimeType; filterContext: QueryFilterContext }): LambdaExpression | undefined => {
            const map = ctx.filterContext.get(QUERY_FILTER_KEY) as ConditionsByType | undefined;
            const wc = map?.get(TypeLogic.typeToId(rootCtor));
            if (wc == null)
                return undefined;
            const rootFilter = buildAuthFilter(rootCtor, new ClassType(rootCtor), wc, TypeAllowedBasic.Read, true);
            return rebasePartFilter(rootFilter, ctx.elementType, chain);
        };
    }

    // The async row-security provider (Schema.queryFilterProviders): build the CURRENT role's conditions
    // map — typeId → WithConditions for every conditioned type — that the sync hook reads during binding.
    // Returns undefined (→ no filtering) when there is no current role or auth is disabled. Runs the async
    // getAllowed (rulesLazy + role-graph merge) once per query, so no cache is kept permanently warm.
    async function buildCurrentRoleConditions(): Promise<ConditionsByType | undefined> {
        const rk = AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return undefined;
        const map: ConditionsByType = new Map();
        for (const ctor of TypeConditionLogic.types()) {
            const typeId = TypeLogic.typeToId(ctor);
            map.set(typeId, await getAllowed(typeId, rk));
        }
        return map;
    }

    // Write gate (Signum's Schema_Saving per-instance check): block saving a row that a type CONDITION
    // denies writing. Scoped to conditioned types where the role CAN write some rows (max DB >= Write) — a
    // type the role can't write at all is an operation-auth concern (not ported), so we don't block those
    // here (that would break legitimate self-service saves on Read-only types). No current role → no gate.
    async function authSaveGate(entities: Entity[]): Promise<void> {
        const rk = AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return;
        // Batch-fill the DB-only conditions of the conditioned entities being saved up front (Signum fills
        // _typeConditions during the save) — one query per type — so the per-instance isAllowedFor below
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
            const wc = await getAllowed(TypeLogic.typeToId(ctor), rk);
            if (maxBound(wc, false) < TypeAllowedBasic.Write)
                continue;
            if (!(await isAllowedFor(e, TypeAllowedBasic.Write, false, rk)))
                throw new UnauthorizedAccessException(`Not authorized to save ${ctor.name} '${String(e.id)}' — denied by a type condition`);
        }
    }

    // Read gate (Signum's EntityEventsGlobal.Retrieved): deny retrieving a type the current role cannot Read
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
            try { typeId = TypeLogic.typeToId(ctor); } catch { continue; }
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
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s]));
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
    // condition rows are ordered by their `order` column (Signum's [PreserveOrder]); each row's symbol set
    // resolves its Lite<TypeConditionSymbol> references back to the shared symbol instances.
    function toWithConditions(row: RuleTypeEntity, symbolById: Map<string, TypeConditionSymbol>): WithConditions<TypeAllowed> {
        const conditionRules = [...row.conditionRules]
            .sort((a, b) => Number(a.order) - Number(b.order))
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

    /** The loaded type-rule cache (Signum's warm RoleAllowedCache) — awaited by dimensions that fold over
     *  the type allowance synchronously (property ceilings, query/operation type-based defaults) and by the
     *  serialization-auth context. */
    export function rulesCache(): Promise<TypeRulesCache> {
        return rulesLazy.value();
    }

    /** The full WithConditions<TypeAllowed> for a type id and role. No current role → simple Write. */
    export async function getAllowed(typeId: PrimaryKey, roleKey?: string): Promise<WithConditions<TypeAllowed>> {
        return (await rulesLazy.value()).getAllowed(typeId, roleKey);
    }

    /** The type's configured type-condition SETS for a role (each an AND-ed TypeConditionSymbol set), from
     *  the role's merged type rule condition rows. These are the selectable "slices" in the property /
     *  operation rule editors (Signum's PropertyRulePack.AvailableTypeConditions). Empty when the type/role
     *  has no condition rules. (A Part collapses to a scalar with no conditions → empty; a part's property
     *  rules are edited on the Fallback slice only.) */
    export async function conditionSetsForType(typeId: PrimaryKey, roleKey?: string): Promise<TypeConditionSymbol[][]> {
        const wc = await getAllowed(typeId, roleKey);
        return wc.conditionRules.map(cr => [...cr.typeConditions]);
    }

    /** The role's coarse MAX UI-read allowance for a type (Signum's TypeInfo.maxTypeAllowed source) —
     *  None/Read/Write. Shipped per type in the reflection blob so the client can render a `None` type's
     *  EntityLink as text (not a link). */
    export async function maxTypeAllowedUI(typeId: PrimaryKey, roleKey?: string): Promise<TypeAllowedBasic> {
        return maxBound(await getAllowed(typeId, roleKey), true);
    }

    /** Coarse "can this role reach `requested` for this type AT ALL" (Signum's Max* bound) — used by the
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

    // Signum's TypeAuthLogic.IsAllowedFor(entity, …) — the per-INSTANCE evaluation (last-match-wins):
    // Min/Max short-circuits, then iterate the condition rules IN REVERSE and return on the first whose
    // symbol set ALL holds for the entity (in-memory predicates), else the fallback. Used by the save gate
    // + the in-memory branch of the row filter (Phase D). No current role (auth off) → allowed.
    export async function isAllowedFor(entity: Entity, requested: TypeAllowedBasic, userInterface: boolean, roleKey?: string): Promise<boolean> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return true;
        const tac = await getAllowed(TypeLogic.typeToId(entity.constructor), rk);
        const min = minBound(tac, userInterface);
        if (requested <= min)
            return true;
        const max = maxBound(tac, userInterface);
        if (max < requested)
            return false;
        // Some of this role's condition rules may reference DB-only conditions (no in-memory predicate);
        // pre-evaluate them against this entity in SQL so the sync inTypeCondition below can read the result
        // (a no-op when every condition is registerCompile'd — the common case). Signum fills at retrieve.
        await TypeConditionLogic.fillTypeConditions([entity]);
        for (let i = tac.conditionRules.length - 1; i >= 0; i--) {
            const cond = tac.conditionRules[i];
            if (cond.typeConditions.every(tc => TypeConditionLogic.inTypeCondition(entity, tc)))
                return typeAllowedGet(cond.allowed, userInterface) >= requested;
        }
        return typeAllowedGet(tac.fallback, userInterface) >= requested;
    }

    // The value a role would get for a type with NO explicit rule (Signum's AuthCache.GetAllowedBase).
    export async function getAllowedBase(typeId: PrimaryKey, roleKey: string): Promise<WithConditions<TypeAllowed>> {
        return (await rulesLazy.value()).getAllowedBase(typeId, roleKey);
    }

    const symbolLite = (s: TypeConditionSymbol): Lite<TypeConditionSymbol> => TypeConditionSymbol.newLite(s.id, s.key);

    // Runtime WithConditions → the mutable transport model (Signum's ToModel).
    function toModel(wc: WithConditions<TypeAllowed>): WithConditionsModel {
        return WithConditionsModel.create({
            fallback: wc.fallback,
            conditionRules: wc.conditionRules.map(cr => ConditionRuleModel.create({
                typeConditions: cr.typeConditions.map(symbolLite),
                allowed: cr.allowed,
            })),
        });
    }

    // Edited model → runtime WithConditions (Signum's ToImmutable), resolving each condition's symbol Lite
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

    // Signum's AuthCache.GetRules — the admin pack: every type with the role's effective `allowed` and its
    // inherited `allowedBase` (each a full WithConditionsModel: fallback + condition rules), plus the
    // `availableConditions` the type registered (so the UI can offer them). The resource Lite carries the
    // clean name as its toStr for display.
    export async function getTypeRulePack(roleId: PrimaryKey): Promise<TypeRulePack> {
        const role = await table(RoleEntity).filter(r => r.id == roleId).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${roleId}' not found`);
        const roleKey = role.toLite().key();
        // typeId -> the symbols registered for that type (only types with conditions appear).
        const availableByType = new Map<PrimaryKey, TypeConditionSymbol[]>(
            TypeConditionLogic.types().map(ctor => [TypeLogic.typeToId(ctor), TypeConditionLogic.conditionsFor(ctor)]));
        const rules: TypeAllowedRule[] = [];
        for (const t of await table(TypeEntity).toArray() as TypeEntity[]) {
            // Hide Parts (they inherit their owner — see PartOwnership) and enum side-tables (Signum does
            // too); a SharedPart is NOT a partRootCtor key, so it stays visible with its own manual rules.
            const ctor = TypeLogic.tryGetType(t.id);
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

    // Signum's AuthCache.SetRules — persist the pack: a value equal to its inherited base is redundant
    // (delete the explicit rule); otherwise upsert a RuleType with the fallback + condition rows. Then
    // invalidate the cache. The condition rows (RuleTypeConditionEntity + its symbol junction) are owned,
    // so replacing the array orphan-deletes the old rows and inserts the new on save.
    export async function setTypeRulePack(pack: TypeRulePack): Promise<void> {
        const role = await table(RoleEntity).filter(r => r.id == pack.role.id).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${pack.role.id}' not found`);
        const roleLite = role.toLite();
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s]));
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
                order: toInt(i),
                allowed: cr.allowed,
                conditions: cr.typeConditions.map(lite => RuleTypeConditionEntity_Condition.create({ symbol: lite })),
            }));
            await rt.save();
        }
        invalidate();
    }

    // ---- AuthRules XML (Signum's TypeCache.ExportXml / ImportXml) ------------------------------
    async function exportXml(ctx: AuthExportCtx): Promise<{ name: string; content: unknown }> {
        const typeName = new Map((await table(TypeEntity).toArray() as TypeEntity[]).map(t => [String(t.id), t.cleanName]));
        const condKey = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s.key]));
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
