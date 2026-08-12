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
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { cleanTypeName, getLocation } from "@altea/altea/data/registration";
import type { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import type { PrimaryKey, Type } from "@altea/altea/data/entity";
import { toInt } from "@altea/altea/data/basics";
import { AuthLogic, type RoleGraphData } from "./AuthLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import {
    RuleTypeEntity, RuleTypeConditionEntity, RuleTypeConditionEntity_Conditions,
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
import { buildAuthFilter, authFilterLambda, rebasePartFilter } from "./TypeConditionAlgebra";
import { computeAllowed, computeAllowedSync, type ComputedCache } from "./AuthCache";

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
    // Signum's AuthCache: `rules` = the raw per-role rules read from the DB; `computed` = the merged
    // (role, typeId) → WithConditions cache (RoleAllowedCache). Both live inside ONE GlobalLazy so they
    // reset together when a RuleType or Role is saved (InvalidateWith).
    interface RulesCache {
        rules: Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>>;
        computed: ComputedCache<WithConditions<TypeAllowed>>;
    }
    let rulesLazy: ResetLazy<RulesCache>;
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
        rulesLazy = sb.globalLazy(async () => ({ rules: await loadRules(), computed: new Map() }),
            { invalidateWith: [RuleTypeEntity, RoleEntity] });
        // Enforcement. The save gate (Signum's Schema_Saving) is installed now. The row-read FILTER
        // (Signum's FilterQuery) goes on each CONDITIONED type's EntityEvents.queryFilter so the LINQ binder
        // applies it to EVERY query (retrieve, dynamic query, navigation). The binder is sync, so the data it
        // needs is resolved ASYNC before each translation: register an async provider that builds the current
        // role's conditions into the opaque QueryFilterContext (no permanently-warm cache). The per-type sync
        // hooks are installed in a schema.initializing hook — only once ALL conditions are registered (app
        // conditions register after this start).
        preSaveGates.push(authSaveGate);
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

    const getDefaultType = async (roleKey: string): Promise<WithConditions<TypeAllowed>> =>
        WithConditions.simple((await AuthLogic.getDefaultAllowed(roleKey)) ? TypeAllowed.Write : TypeAllowed.None);

    /** The immutable type-rule snapshot for a SerializationAuthContext (Signum's warm RoleAllowedCache,
     *  captured up-front). Resolving the lazy's Promise<T> here — never exposing the box naked — so the sync
     *  compute below reads a frozen value that a concurrent invalidation can't null out. */
    export type RulesSnapshot = RulesCache;
    export function rulesSnapshot(): Promise<RulesCache> {
        return rulesLazy.value();
    }

    /** SYNC twin of getAllowed for the serialization-auth path — computes from the CAPTURED snapshot
     *  (`typeCtx`) + role graph (`graph`), both frozen in the SerializationAuthContext. No current role →
     *  simple Write. */
    export function getAllowedFromCtx(typeId: PrimaryKey, roleKey: string | undefined, typeCtx: RulesCache, graph: RoleGraphData): WithConditions<TypeAllowed> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null)
            return WithConditions.simple(TypeAllowed.Write);
        const ctor = TypeLogic.tryGetType(typeId);
        const rootCtor = ctor != null ? partRootCtor.get(ctor) : undefined;
        if (rootCtor != null)
            return collapseToScalar(getAllowedFromCtx(TypeLogic.typeToId(rootCtor), rk, typeCtx, graph));
        const relatedTo = (r: string): Set<string> => graph.graph.tryRelatedTo(r);
        const mergeStrategy = (r: string): MergeStrategy => graph.mergeStrategies.get(r)?.strategy ?? MergeStrategy.Union;
        const getDefaultSync = (r: string): WithConditions<TypeAllowed> =>
            WithConditions.simple((graph.mergeStrategies.get(r)?.defaultAllowed ?? false) ? TypeAllowed.Write : TypeAllowed.None);
        return computeAllowedSync<WithConditions<TypeAllowed>>(rk, typeId, typeCtx.rules, mergeType, getDefaultSync, typeCtx.computed, relatedTo, mergeStrategy);
    }

    /** The full WithConditions<TypeAllowed> for a type id and role. No current role (anonymous / auth off)
     *  → simple Write. */
    export async function getAllowed(typeId: PrimaryKey, roleKey?: string): Promise<WithConditions<TypeAllowed>> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null)
            return WithConditions.simple(TypeAllowed.Write);
        // A Part inherits its ROOT owner's allowance (collapsed to a condition-free scalar). No own rule.
        const ctor = TypeLogic.tryGetType(typeId);
        const rootCtor = ctor != null ? partRootCtor.get(ctor) : undefined;
        if (rootCtor != null)
            return collapseToScalar(await getAllowed(TypeLogic.typeToId(rootCtor), rk));
        const { rules, computed } = await rulesLazy.value();
        return computeAllowed<WithConditions<TypeAllowed>>(rk, typeId, rules, mergeType, getDefaultType, computed);
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
        for (let i = tac.conditionRules.length - 1; i >= 0; i--) {
            const cond = tac.conditionRules[i];
            if (cond.typeConditions.every(tc => TypeConditionLogic.inTypeCondition(entity, tc)))
                return typeAllowedGet(cond.allowed, userInterface) >= requested;
        }
        return typeAllowedGet(tac.fallback, userInterface) >= requested;
    }

    // The value a role would get for a type with NO explicit rule (Signum's AuthCache.GetAllowedBase):
    // the merge of its direct parents' allowed values, or the role default if it is a root role.
    export async function getAllowedBase(typeId: PrimaryKey, roleKey: string): Promise<WithConditions<TypeAllowed>> {
        const parents = await AuthLogic.relatedTo(roleKey);
        if (parents.size === 0)
            return getDefaultType(roleKey);
        return mergeType(await AuthLogic.getMergeStrategy(roleKey), await Promise.all([...parents].map(p => getAllowed(typeId, p))));
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
            const summary = async (fn: SummaryFn | undefined): Promise<DimensionSummaryModel> => {
                const s = fn == null ? undefined : await fn(t.cleanName, roleKey);
                return DimensionSummaryModel.create({ min: toInt(s?.min ?? -1), max: toInt(s?.max ?? -1) });
            };
            rules.push(TypeAllowedRule.create({
                resource: TypeEntity.newLite(t.id, t.cleanName),
                allowed: toModel(await getAllowed(t.id, roleKey)),
                allowedBase: toModel(await getAllowedBase(t.id, roleKey)),
                availableConditions: (availableByType.get(t.id) ?? []).map(symbolLite),
                ownedParts: ownedPartClosure(t.cleanName).slice(1), // [owner, ...parts] → just the parts
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
                conditions: cr.typeConditions.map(lite => RuleTypeConditionEntity_Conditions.create({ symbol: lite })),
            }));
            await rt.save();
        }
        invalidate();
    }
}
